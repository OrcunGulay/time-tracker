/**
 * Seed betigi.
 *
 *   npm run seed            -> temel kayitlar (admin, yonetici, 2 personel, projeler, gorevler)
 *   npm run seed -- --demo  -> ek olarak son 3 gun icin gercekci aktivite verisi uretir
 *
 * Idempotent: mevcut kayitlari atlar.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { closePool, query, queryOne } from './pool.js';
import { hashPassword } from '../lib/crypto.js';
import * as activityRepo from '../repositories/activity.repo.js';
import * as projectRepo from '../repositories/project.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as userRepo from '../repositories/user.repo.js';
import * as categoryService from '../services/category.service.js';
import { extractDomain } from '../services/productivity.service.js';

const DEMO = process.argv.includes('--demo');
const SAMPLE_INTERVAL = 20; // saniye
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(__dirname, '../../sql');

/**
 * Varsayilan uretkenlik kurallarini yukler.
 *
 * Tek dogruluk kaynagi `sql/002_seed_categories.sql` dosyasidir; migration ile
 * ayni dosya uygulanir. Bu adim, tablonun (orn. test/dev sifirlamasi sonrasi)
 * bos kalmasi durumunda kurallari geri getirir - aksi halde tum etiketler
 * NEUTRAL olur ve uretkenlik skoru 0 cikar.
 */
async function seedDefaultRules(): Promise<void> {
  const file = path.join(SQL_DIR, '002_seed_categories.sql');
  try {
    const sql = await readFile(file, 'utf8');
    await query(sql);
    console.log('[seed] varsayilan kategori kurallari uygulandi (002_seed_categories.sql).');
  } catch (err) {
    console.warn('[seed] varsayilan kategori kurallari yuklenemedi:', (err as Error).message);
  }
}

interface DemoUserSpec {
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'employee';
  department: string | null;
  hourlyRate: number;
  password: string;
}

const PEOPLE: DemoUserSpec[] = [
  { name: 'Sistem Yoneticisi', email: 'admin@localhost', role: 'admin', department: 'Yonetim', hourlyRate: 750, password: 'Admin123!' },
  { name: 'Deniz Yilmaz', email: 'deniz@localhost', role: 'manager', department: 'Yazilim', hourlyRate: 850, password: 'Deniz123!' },
  { name: 'Ada Kaya', email: 'ada@localhost', role: 'employee', department: 'Yazilim', hourlyRate: 600, password: 'Ada123!' },
  { name: 'Mert Demir', email: 'mert@localhost', role: 'employee', department: 'Tasarim', hourlyRate: 550, password: 'Mert123!' },
];

/** Demo aktivite uretiminde kullanilan gercekci uygulama/domain havuzu. */
const APP_POOL: Array<{ app: string; titles: string[]; domain?: string; weight: number }> = [
  { app: 'Code', titles: ['activity.service.ts - timetracker', 'report.routes.ts - timetracker'], weight: 34 },
  { app: 'chrome.exe', titles: ['GitHub - Pull requests'], domain: 'github.com', weight: 12 },
  { app: 'chrome.exe', titles: ['Stack Overflow - How to index jsonb'], domain: 'stackoverflow.com', weight: 6 },
  { app: 'chrome.exe', titles: ['YouTube - Lo-fi beats'], domain: 'youtube.com', weight: 7 },
  { app: 'chrome.exe', titles: ['Instagram'], domain: 'instagram.com', weight: 4 },
  { app: 'Terminal', titles: ['npm run dev - backend'], weight: 9 },
  { app: 'Slack', titles: ['#genel - Slack'], weight: 8 },
  { app: 'Figma', titles: ['Dashboard - Timeline ekrani'], weight: 6 },
  { app: 'zoom.us', titles: ['Sprint toplantisi'], weight: 5 },
  { app: 'Finder', titles: ['Downloads'], weight: 3 },
  { app: 'Notion', titles: ['Sprint plani'], weight: 3 },
  { app: 'Spotify', titles: ['Focus playlist'], weight: 3 },
];

function pickWeighted(totalWeight: number): (typeof APP_POOL)[number] {
  let roll = Math.random() * totalWeight;
  for (const item of APP_POOL) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return APP_POOL[0] as (typeof APP_POOL)[number];
}

async function seedBase(): Promise<Map<string, string>> {
  await seedDefaultRules();

  const ids = new Map<string, string>();
  for (const person of PEOPLE) {
    const existing = await userRepo.findByEmail(person.email);
    if (existing) {
      ids.set(person.email, existing.id);
      if (person.hourlyRate > 0 && (existing.hourlyRate === 0 || !existing.isActive)) {
        await userRepo.updateUser(existing.id, { hourlyRate: person.hourlyRate, isActive: true });
      }
      continue;
    }
    const created = await userRepo.createUser({
      name: person.name,
      email: person.email,
      passwordHash: await hashPassword(person.password),
      role: person.role,
      department: person.department,
      hourlyRate: person.hourlyRate,
      currency: 'TRY',
    });
    ids.set(person.email, created.id);
    console.log(`[seed] kullanici: ${person.email} (sifre: ${person.password})`);
  }

  let projects = await projectRepo.listProjects(true);
  if (projects.length === 0) {
    const p1 = await projectRepo.createProject({
      name: 'Zaman Takip Platformu',
      description: 'Masaustu agent + backend + dashboard gelistirmesi',
    });
    const p2 = await projectRepo.createProject({
      name: 'Mobil Uygulama Yenileme',
      description: 'iOS/Android uygulama yeniden tasarimi',
    });
    projects = [p1, p2];

    await projectRepo.createTask({ projectId: p1.id, title: 'Telemetri API', status: 'in_progress' });
    await projectRepo.createTask({ projectId: p1.id, title: 'Bordro modulu', status: 'todo' });
    await projectRepo.createTask({ projectId: p2.id, title: 'Tasarim sistemi', status: 'todo' });
    console.log('[seed] 2 proje ve 3 gorev olusturuldu.');
  }

  // Tum personeli tum projelere uye yap (demo kolayligi)
  for (const person of PEOPLE) {
    const userId = ids.get(person.email);
    if (!userId) continue;
    for (const project of projects) {
      await projectRepo.addProjectMember(project.id, userId);
    }
  }

  return ids;
}

/** Son N gun icin gercekci oturum + aktivite verisi uretir. */
async function seedDemoActivity(ids: Map<string, string>, days = 3): Promise<void> {
  const employees = ['ada@localhost', 'mert@localhost', 'deniz@localhost'];
  const tasks = await projectRepo.listTasks({});
  const totalWeight = APP_POOL.reduce((sum, a) => sum + a.weight, 0);

  for (const email of employees) {
    const userId = ids.get(email);
    if (!userId) continue;

    for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
      const existing = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM sessions
         WHERE user_id = $1 AND start_time::date = (now() - ($2 || ' days')::interval)::date`,
        [userId, dayOffset],
      );
      if ((existing?.count ?? 0) > 0) continue;

      const workSeconds = (6 + Math.random() * 3) * 3600; // 6-9 saat
      const dayStart = new Date();
      dayStart.setDate(dayStart.getDate() - dayOffset);
      dayStart.setHours(9, Math.floor(Math.random() * 40), 0, 0);

      // Bugun icin: mesai gelecege sarkmasin, calismayi simdiki zamana sigdir
      let startTime = dayStart;
      if (dayOffset === 0 && startTime.getTime() + workSeconds * 1000 > Date.now()) {
        startTime = new Date(Date.now() - workSeconds * 1000 - 30 * 60 * 1000);
      }
      const endTime = new Date(startTime.getTime() + workSeconds * 1000);

      const task = tasks.length > 0 ? tasks[Math.floor(Math.random() * tasks.length)] : null;
      const session = await sessionRepo.startSession({
        userId,
        projectId: task?.projectId ?? null,
        taskId: task?.id ?? null,
        startTime,
        clientStartedAt: startTime,
        clientInfo: { seeded: true, os: 'demo' },
      });

      const rows: activityRepo.ActivityInsertRow[] = [];
      const contexts: Array<{ activeApp: string; windowTitle: string; url: string | null; domain: string | null }> = [];
      let cursor = startTime.getTime();
      let idleUntil = 0;

      while (cursor < endTime.getTime()) {
        const ts = new Date(cursor);
        // ogle arasi ve rastgele bosluklar
        const hour = ts.getHours() + ts.getMinutes() / 60;
        const lunch = hour >= 12.5 && hour < 13.5;
        const idle = lunch || (idleUntil > cursor);
        if (!idle && Math.random() < 0.01) idleUntil = cursor + (180 + Math.random() * 600) * 1000;

        const pick = pickWeighted(totalWeight);
        const title = pick.titles[Math.floor(Math.random() * pick.titles.length)] ?? pick.app;
        const url = pick.domain ? `https://${pick.domain}/` : null;
        const domain = pick.domain ?? extractDomain(url);

        contexts.push({ activeApp: pick.app, windowTitle: title, url, domain });
        rows.push({
          timestamp: ts,
          activeApp: pick.app,
          windowTitle: title,
          url,
          domain,
          monitorIndex: 0,
          mouseEvents: idle ? 0 : Math.floor(Math.random() * 25),
          keyboardEvents: idle ? 0 : Math.floor(Math.random() * 60),
          mouseDistance: idle ? 0 : Math.floor(Math.random() * 900),
          isIdle: idle,
          idleSeconds: idle ? Math.floor((cursor - startTime.getTime()) / 1000) % 900 + 180 : 0,
          durationSeconds: SAMPLE_INTERVAL,
          category: 'NEUTRAL',
        });
        cursor += SAMPLE_INTERVAL * 1000;
      }

      const categories = await categoryService.classifyMany(
        contexts.map((c) => ({ activeApp: c.activeApp, url: c.url, domain: c.domain })),
      );
      rows.forEach((row, i) => {
        row.category = categories[i] ?? 'NEUTRAL';
      });

      // 500'luk parcalar halinde yaz (istek sinirlari icin)
      for (let i = 0; i < rows.length; i += 500) {
        await activityRepo.insertBatch(session.id, userId, rows.slice(i, i + 500));
      }

      const agg = await activityRepo.aggregateBySession(session.id);
      await sessionRepo.stopSession(session.id, endTime, {
        totalDuration: agg.totalSeconds,
        idleDuration: agg.idleSeconds,
        productiveSeconds: agg.productiveSeconds,
        unproductiveSeconds: agg.unproductiveSeconds,
        neutralSeconds: agg.neutralSeconds,
      });
      // Etiket yerel tarihi gostersin: `toISOString()` UTC gun verir ve gece
      // yarisini asan oturumlarda "bugun" yanlislikla dun gibi gorunur.
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(startTime);
      console.log(
        `[seed] ${email} ${localDate}: ${rows.length} ornek, ` +
          `${Math.round(agg.totalSeconds / 3600)} saat calisma, ${Math.round(agg.idleSeconds / 60)} dk bosluk`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (config.isProd) {
    console.error('[seed] Uretim ortaminda seed calistirilamaz.');
    process.exit(1);
  }
  const ids = await seedBase();
  if (DEMO) {
    await seedDemoActivity(ids);
  } else {
    console.log('[seed] Demo aktivite verisi icin: npm run seed -- --demo');
  }
  console.log('[seed] tamamlandi.');
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('[seed] hata:', err instanceof Error ? err.message : err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
