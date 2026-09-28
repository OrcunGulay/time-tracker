/**
 * Uctan uca (E2E) entegrasyon testi - GERCEK PostgreSQL gerektirir.
 *
 *   npm run test:integration
 *
 * DATABASE_URL test veritabanina isaret etmelidir (src/test/env.mjs varsayilani:
 * postgresql://localhost:5432/timetracker_test). Test basinda sifirlanir:
 *
 *   createdb timetracker_test
 *   npm run test:integration
 *
 * Kapsam: kimlik dogrulama, agent API anahtari, oturum yasam dongusu,
 * idempotent batch, uretkenlik motoru, canli durum, timeline, ekran goruntusu
 * gizlilik protokolu, idle kredisi, bordro ve RBAC.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { closePool, query, truncateAll } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from '../lib/crypto.js';
import * as userRepo from '../repositories/user.repo.js';
import * as projectRepo from '../repositories/project.repo.js';

const ADMIN = { email: 'e2e-admin@test.local', password: 'Admin123!' };
const EMPLOYEE = { email: 'e2e-employee@test.local', password: 'Employee123!' };
const MANAGER = { email: 'e2e-manager@test.local', password: 'Manager123!' };

let app: FastifyInstance;
let adminToken = '';
let employeeToken = '';
let managerToken = '';
let projectId = '';
let taskId = '';

interface InjectOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string;
  agentKey?: string;
  body?: unknown;
}

async function call(path: string, options: InjectOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.agentKey) headers['x-agent-key'] = options.agentKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await app.inject({
    method: options.method ?? 'GET',
    url: path,
    headers,
    payload: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let json: any = null;
  try {
    json = response.body ? JSON.parse(response.body) : null;
  } catch {
    json = response.body;
  }
  return { status: response.statusCode, body: json };
}

/**
 * Test zamanlari: oturum sunucuda "simdi" acilir, ornekler bu ana gore uretilir.
 * Sabit tarih kullanmak, gunluk rapor/payroll sorgularinin oturumu bulmamasina yol acar.
 */
const BASE_TS = Date.now();
const ts = (offsetSeconds: number): string => new Date(BASE_TS + offsetSeconds * 1000).toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

/** Telemetri ornegi uretici. */
function sample(over: Record<string, unknown> = {}) {
  return {
    timestamp: ts(0),
    activeApp: 'Code',
    windowTitle: 'activity.service.ts - timetracker',
    mouseEvents: 8,
    keyboardEvents: 42,
    mouseDistance: 640,
    isIdle: false,
    idleSeconds: 0,
    durationSeconds: 20,
    ...over,
  };
}

before(async () => {
  if (!/timetracker_test/.test(config.db.url)) {
    throw new Error(
      `Bu test yalnizca test veritabani ile calisir. DATABASE_URL=${config.db.url}\n` +
        'Ornek: DATABASE_URL=postgresql://localhost:5432/timetracker_test npm run test:integration',
    );
  }

  await runMigrations(() => undefined);
  await truncateAll();
  // 002 numarali migration'in seed ettigi kategori kurallarini yeniden uygula
  await query(`
    INSERT INTO category_rules (match_type, pattern, category, priority) VALUES
      ('app', 'code', 'PRODUCTIVE', 10),
      ('app', 'terminal', 'PRODUCTIVE', 20),
      ('domain', 'github.com', 'PRODUCTIVE', 10),
      ('domain', 'youtube.com', 'UNPRODUCTIVE', 10),
      ('domain', 'localhost', 'PRODUCTIVE', 10),
      ('app', 'slack', 'NEUTRAL', 50)
    ON CONFLICT DO NOTHING
  `);

  // timezone: 'UTC' -> raporlarin gun siniri test boyunca deterministik olur
  const admin = await userRepo.createUser({
    name: 'E2E Admin',
    email: ADMIN.email,
    passwordHash: await hashPassword(ADMIN.password),
    role: 'admin',
    department: 'Yonetim',
    hourlyRate: 0,
    timezone: 'UTC',
  });
  await userRepo.createUser({
    name: 'E2E Manager',
    email: MANAGER.email,
    passwordHash: await hashPassword(MANAGER.password),
    role: 'manager',
    department: 'Yazilim',
    hourlyRate: 700,
    timezone: 'UTC',
  });
  const employee = await userRepo.createUser({
    name: 'E2E Employee',
    email: EMPLOYEE.email,
    passwordHash: await hashPassword(EMPLOYEE.password),
    role: 'employee',
    department: 'Yazilim',
    hourlyRate: 600,
    timezone: 'UTC',
  });

  const project = await projectRepo.createProject({ name: 'E2E Projesi' });
  projectId = project.id;
  const task = await projectRepo.createTask({ projectId, title: 'E2E Gorevi', status: 'in_progress' });
  taskId = task.id;
  await projectRepo.addProjectMember(projectId, employee.id);
  await projectRepo.addProjectMember(projectId, admin.id);

  app = await buildApp();
  await app.ready();

  const adminLogin = await call('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  adminToken = adminLogin.body.accessToken;

  const employeeLogin = await call('/api/auth/login', { method: 'POST', body: EMPLOYEE });
  assert.equal(employeeLogin.status, 200);
  employeeToken = employeeLogin.body.accessToken;

  const managerLogin = await call('/api/auth/login', { method: 'POST', body: MANAGER });
  assert.equal(managerLogin.status, 200);
  managerToken = managerLogin.body.accessToken;
});

after(async () => {
  if (app) await app.close();
  await closePool();
});

describe('Saglik ve kimlik dogrulama', () => {
  test('health ucu yanit verir', async () => {
    const response = await call('/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
  });

  test('yanlis parola 401 doner', async () => {
    const response = await call('/api/auth/login', {
      method: 'POST',
      body: { email: EMPLOYEE.email, password: 'yanlis-parola' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'UNAUTHORIZED');
  });

  test('token olmadan korumali uc nokta 401 doner', async () => {
    const response = await call('/api/reports/live');
    assert.equal(response.status, 401);
  });

  test('gecersiz govde 400 doner (sema dogrulama)', async () => {
    const response = await call('/api/auth/login', { method: 'POST', body: { email: 'x' } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'VALIDATION_ERROR');
  });

  test('me ucu kullanici bilgisini doner', async () => {
    const response = await call('/api/auth/me', { token: employeeToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, EMPLOYEE.email);
    assert.equal(response.body.user.role, 'employee');
  });
});

describe('Agent API anahtari', () => {
  test('anahtar uretilir ve x-agent-key ile dogrulanir', async () => {
    const created = await call('/api/auth/agent-key', { method: 'POST', token: employeeToken });
    assert.equal(created.status, 200);
    assert.match(created.body.apiKey, /^tt_[0-9a-f]{48}$/);

    // API anahtari ile oturum baslatilabilmeli
    const started = await call('/api/sessions/start', {
      method: 'POST',
      agentKey: created.body.apiKey,
      body: { projectId, taskId },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.ok(started.body.session.id);

    // Temizlik: anahtari iptal et
    const revoked = await call('/api/auth/agent-key', { method: 'DELETE', token: employeeToken });
    assert.equal(revoked.status, 200);

    const rejected = await call('/api/reports/live', { agentKey: created.body.apiKey });
    assert.equal(rejected.status, 401);
  });
});

describe('Oturum yasam dongusu ve telemetri', () => {
  let sessionId = '';

  test('mesai baslar ve aktif oturum tekildir', async () => {
    const first = await call('/api/sessions/start', {
      method: 'POST',
      token: employeeToken,
      body: { projectId, taskId },
    });
    assert.equal(first.status, 200);
    sessionId = first.body.session.id;

    // Ikinci cagri yeni oturum acmaz (coklu cihaz korumasi)
    const second = await call('/api/sessions/start', { method: 'POST', token: employeeToken, body: {} });
    assert.equal(second.body.session.id, sessionId);
  });

  test('aktivite batch idempotent yazilir ve kategori atanir', async () => {
    const batch = [
      sample({ timestamp: ts(-60), activeApp: 'Code' }),
      sample({
        timestamp: ts(-40),
        activeApp: 'chrome.exe',
        windowTitle: 'Videolar - YouTube',
        url: 'https://www.youtube.com/watch?v=abc',
        domain: 'youtube.com',
      }),
      sample({ timestamp: ts(-20), activeApp: 'Slack', windowTitle: '#genel' }),
      // Bosluk ornegi (en guncel zaman damgasi: ekran 240 sn boyunca bosta kaldi)
      sample({
        timestamp: ts(-5),
        isIdle: true,
        idleSeconds: 240,
        durationSeconds: 240,
        keyboardEvents: 0,
        mouseEvents: 0,
        mouseDistance: 0,
      }),
    ];

    const first = await call('/api/telemetry/activity', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, batch },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.accepted, 4);
    assert.equal(first.body.duplicates, 0);

    // Ayni batch tekrar gonderilir: mukerrer kayit olusmaz
    const second = await call('/api/telemetry/activity', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, batch },
    });
    assert.equal(second.body.accepted, 0);
    assert.equal(second.body.duplicates, 4);

    const { rows } = await query<{ category: string; count: number }>(
      `SELECT category, count(*)::int AS count FROM activity_logs
       WHERE session_id = $1 GROUP BY category ORDER BY category`,
      [sessionId],
    );
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
    // Bosluk ornegi de aktif uygulamaya gore etiketlenir (skorda is_idle ile dislanir)
    assert.equal(byCategory.PRODUCTIVE, 2, 'Code ornekleri -> PRODUCTIVE olmali');
    assert.equal(byCategory.UNPRODUCTIVE, 1, 'youtube.com -> UNPRODUCTIVE olmali');
    assert.equal(byCategory.NEUTRAL, 1, 'Slack -> NEUTRAL olmali');

    // Sureler sunucuda loglardan yeniden hesaplanir
    const totals = await query<{ total_duration: number; idle_duration: number }>(
      'SELECT total_duration, idle_duration FROM sessions WHERE id = $1',
      [sessionId],
    );
    assert.equal(totals.rows[0]?.total_duration, 300); // 3 x 20 sn aktif + 240 sn bosluk
    assert.equal(totals.rows[0]?.idle_duration, 240);
  });

  test('heartbeat canli durum ve toplamlari doner', async () => {
    const response = await call('/api/telemetry/heartbeat', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, status: 'active', activeApp: 'Code', idleSeconds: 0 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.session.totalDuration, 300);
    assert.equal(response.body.session.idleDuration, 240);
    assert.equal(response.body.commands.stopSession, false);
    assert.equal(response.body.session.status, 'active');
  });

  test('bosluk esigi asilinca idle olayi olusur', async () => {
    const response = await call('/api/telemetry/heartbeat', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, status: 'idle', idleSeconds: 240 },
    });
    assert.equal(response.body.commands.forceIdle, true);

    const { rows } = await query<{ idle_seconds: number; decision: string | null }>(
      'SELECT idle_seconds, decision FROM idle_events WHERE session_id = $1',
      [sessionId],
    );
    // Bosluk ornegi ve heartbeat ayni "bosluk donemine" aittir: tek kayit olmali
    assert.equal(rows.length, 1, 'tek idle olayi beklenir');
    assert.ok((rows[0]?.idle_seconds ?? 0) >= 180);
    assert.equal(rows[0]?.decision, null);
  });

  test('idle karari "count" secilirse sure geri eklenir (idle_duration korunur)', async () => {
    const response = await call('/api/telemetry/idle-decision', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, decision: 'count', idleSeconds: 240 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.creditedSeconds, 240);
    assert.equal(response.body.session.creditedSeconds, 240);

    const { rows } = await query<{ idle_duration: number; credited_seconds: number }>(
      'SELECT idle_duration, credited_seconds FROM sessions WHERE id = $1',
      [sessionId],
    );
    // Denetim icin gercek bosluk korunur, yalnizca kredi artar
    assert.equal(rows[0]?.idle_duration, 240);
    assert.equal(rows[0]?.credited_seconds, 240);

    // Ikinci kez "count" gonderilirse kredi bosluk suresini asamaz (cift sayim yok)
    const again = await call('/api/telemetry/idle-decision', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, decision: 'count', idleSeconds: 240 },
    });
    assert.equal(again.body.creditedSeconds, 0);
    assert.equal(again.body.session.creditedSeconds, 240);
  });

  test('oturum durdurulur ve toplamlar hesaplanir', async () => {
    const response = await call('/api/sessions/stop', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId, endedAt: ts(0) },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const session = response.body.session;
    assert.equal(session.status, 'stopped');
    assert.equal(session.deductedSeconds, 0);
    assert.equal(session.creditedSeconds, 240);
    assert.equal(session.totalDuration, 300);
    assert.equal(session.idleDuration, 240);
    // Sayilan bosluk nedeniyle odenebilir sure tum takip suresine esit
    assert.equal(session.payableSeconds, 300);
    // Odenebilir = toplam - bosluk - silinen + sayilan
    assert.equal(
      session.payableSeconds,
      session.totalDuration - session.idleDuration - session.deductedSeconds + session.creditedSeconds,
    );
  });

  test('kapali oturum icin gecmis zamanli batch kabul edilir (offline kuyruk)', async () => {
    const response = await call('/api/telemetry/activity', {
      method: 'POST',
      token: employeeToken,
      body: {
        sessionId,
        batch: [sample({ timestamp: ts(-10), activeApp: 'Terminal' })],
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.accepted, 1);

    // Oturum kapanis zamani silinmemeli
    const { rows } = await query<{ end_time: Date | null }>(
      'SELECT end_time FROM sessions WHERE id = $1',
      [sessionId],
    );
    assert.ok(rows[0]?.end_time, 'durdurulmus oturumun bitis zamani korunmali');
  });

  test('oturum araligi disindaki gecmis batch reddedilir', async () => {
    const response = await call('/api/telemetry/activity', {
      method: 'POST',
      token: employeeToken,
      body: {
        sessionId,
        batch: [sample({ timestamp: '2020-01-01T09:00:00.000Z' })],
      },
    });
    assert.equal(response.status, 400);
  });
});

describe('Ekran goruntusu gizlilik protokolu', () => {
  let screenshotId = '';

  test('presigned URL uretilir ve kayit olusur', async () => {
    const session = await call('/api/sessions/start', { method: 'POST', token: employeeToken, body: {} });
    const sessionId = session.body.session.id;

    const response = await call('/api/telemetry/screenshot/presigned-url', {
      method: 'POST',
      token: employeeToken,
      body: {
        sessionId,
        // Timeline'da idle diliminden ayri bir dilime dusmesi icin 15 dk once
        capturedAt: ts(-900),
        monitorIndex: 0,
        monitorName: 'Monitor 1',
        contentType: 'image/webp',
        sizeBytes: 1024,
        blurApplied: true,
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const payload = response.body;
    screenshotId = payload.screenshotId;
    assert.match(payload.storageKey, /^screenshots\/[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/\d+-m0\.webp$/);
    assert.ok(payload.uploadUrl.includes(config.s3.bucket));
    assert.equal(payload.method, 'PUT');
    assert.equal(payload.headers['Content-Type'], 'image/webp');

    const confirm = await call('/api/telemetry/screenshot/confirm', {
      method: 'POST',
      token: employeeToken,
      body: { screenshotId, sizeBytes: 2048, width: 1920, height: 1080 },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.screenshot.width, 1920);
  });

  test('calisan kendi goruntusunu siler ve 10 dk blok dusulur', async () => {
    const response = await call(`/api/screenshots/${screenshotId}`, {
      method: 'DELETE',
      token: employeeToken,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.deductedSeconds, config.rules.screenshotBlockSeconds);
    assert.ok(response.body.session.deductedSeconds > 0);

    // Denetim kaydi yazilmali
    const { rows } = await query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE action = 'screenshot.delete_by_employee' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.metadata.deductedSeconds, config.rules.screenshotBlockSeconds);

    // Ikinci silme denemesi 404 (zaten silinmis)
    const again = await call(`/api/screenshots/${screenshotId}`, { method: 'DELETE', token: employeeToken });
    assert.equal(again.status, 404);
  });

  test('baska bir kullanicinin goruntusu silinemez', async () => {
    const session = await call('/api/sessions/start', { method: 'POST', token: employeeToken, body: {} });
    const presign = await call('/api/telemetry/screenshot/presigned-url', {
      method: 'POST',
      token: employeeToken,
      body: { sessionId: session.body.session.id, capturedAt: new Date().toISOString(), monitorIndex: 1 },
    });
    const id = presign.body.screenshotId;

    const response = await call(`/api/screenshots/${id}`, { method: 'DELETE', token: managerToken });
    assert.equal(response.status, 403);
  });
});

describe('Raporlar', () => {
  test('gunluk rapor sureleri ve uretkenlik skorunu hesaplar', async () => {
    const response = await call(`/api/reports/daily?date=${TODAY}`, { token: adminToken });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = response.body.rows.find((r: { email: string }) => r.email === EMPLOYEE.email);
    assert.ok(row, 'calisan icin satir donmeli');
    assert.ok(row.trackedSeconds >= 300, 'takip edilen sure 300 sn olmali');
    assert.ok(row.productiveSeconds > 0);
    assert.ok(row.unproductiveSeconds > 0);
    assert.ok(row.idleSeconds >= 240);
    // Kategori kirilimi aktivite loglarindan gelir: 40 sn uretken, 20 sn uretken
    // degil, 20 sn notr -> 40 / 80 = %50 (bosluk ornegi is_idle ile dislanir)
    assert.equal(row.productiveSeconds, 40);
    assert.equal(row.unproductiveSeconds, 20);
    assert.equal(row.productivityScore, 50);
    assert.ok(row.payableSeconds >= 0);
  });

  test('canli durum agent verisini yansitir', async () => {
    const response = await call('/api/reports/live', { token: adminToken });
    assert.equal(response.status, 200);
    const row = response.body.items.find((r: { email: string }) => r.email === EMPLOYEE.email);
    assert.ok(row);
    assert.ok(['active', 'idle', 'offline'].includes(row.status));
  });

  test('timeline dilimleri ve ozeti uretilir', async () => {
    const users = await call('/api/admin/users?search=e2e-employee', { token: adminToken });
    const employeeId = users.body.items[0].id;
    const response = await call(`/api/reports/timeline?userId=${employeeId}&date=${TODAY}&slotMinutes=5`, {
      token: adminToken,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.slots.length > 0);
    const states = response.body.slots.map((slot: { state: string }) => slot.state);
    assert.ok(
      states.every((state: string) =>
        ['active', 'idle', 'unproductive', 'deducted', 'offline'].includes(state),
      ),
    );
    // Bosluk ornegi dilimi ve silinen ekran goruntusu blogu isaretlenmis olmali
    assert.ok(states.includes('idle'), 'idle dilimi bulunmali');
    assert.ok(states.includes('deducted'), 'silinen blok isaretlenmeli');
    assert.ok(response.body.summary.deductedMinutes > 0);
  });

  test('uygulama kullanim dagilimi doner', async () => {
    const response = await call(`/api/reports/usage?date=${TODAY}&groupBy=app`, { token: adminToken });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.items));
    assert.ok(response.body.items.length > 0);
  });

  test('domain kirilimi video sitesini uretken degil olarak isaretler', async () => {
    const response = await call(`/api/reports/usage?date=${TODAY}&groupBy=domain`, { token: adminToken });
    const youtube = response.body.items.find((item: { key: string }) => item.key === 'youtube.com');
    assert.ok(youtube);
    assert.equal(youtube.category, 'UNPRODUCTIVE');
  });

  test('urelkenlik raporu kullanici kirilimi doner', async () => {
    const response = await call(`/api/reports/productivity?from=${MONTH_START}&to=${TODAY}`, {
      token: adminToken,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.users.length > 0);
    assert.ok(response.body.overall.productiveSeconds > 0);
  });

  test('kategori kurali testi dogru etiket doner', async () => {
    const response = await call('/api/admin/categories/test?app=chrome.exe&url=https://youtube.com/watch?v=1', {
      token: adminToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.category, 'UNPRODUCTIVE');
  });
});

describe('Bordro', () => {
  test('ozet odenebilir sure ve tutari hesaplar', async () => {
    const response = await call(`/api/payroll/summary?periodStart=${MONTH_START}&periodEnd=${TODAY}`, {
      token: adminToken,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const line = response.body.items.find((item: { email: string }) => item.email === EMPLOYEE.email);
    assert.ok(line, 'calisan bordro satiri olmali');
    assert.equal(line.hourlyRate, 600);
    assert.ok(line.payableSeconds > 0, 'sayilan bosluk nedeniyle odenebilir sure pozitif olmali');
    assert.ok(line.sessionCount >= 1);
    assert.equal(line.amount, Math.round(line.payableHours * 600 * 100) / 100);
  });

  test('CSV ciktisi uretilir', async () => {
    const response = await call(
      `/api/payroll/export?periodStart=${MONTH_START}&periodEnd=${TODAY}&format=csv`,
      { token: adminToken },
    );
    assert.equal(response.status, 200);
    assert.match(String(response.body), /Personel;E-posta/);
  });

  test('PDF ciktisi uretilir', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/payroll/export?periodStart=${MONTH_START}&periodEnd=${TODAY}&format=pdf`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /application\/pdf/);
    assert.equal(response.rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.ok(response.rawPayload.length > 1000);
  });

  test('calisan kendi bordrosunu gorebilir', async () => {
    const response = await call(`/api/payroll/me?periodStart=${MONTH_START}&periodEnd=${TODAY}`, {
      token: employeeToken,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.items.every((item: { email: string }) => item.email === EMPLOYEE.email));
  });

  test('donem dondurulur (issued)', async () => {
    const response = await call('/api/payroll/issue', {
      method: 'POST',
      token: adminToken,
      body: { periodStart: MONTH_START, periodEnd: TODAY },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.issued >= 1);

    const runs = await call('/api/payroll/runs', { token: adminToken });
    assert.ok(runs.body.items.length >= 1);
    assert.ok(runs.body.items.some((run: { status: string }) => run.status === 'issued'));
  });
});

describe('RBAC ve yonetim', () => {
  test('calisan kullanici listesine erisemez', async () => {
    const response = await call('/api/admin/users', { token: employeeToken });
    assert.equal(response.status, 403);
  });

  test('calisan baska kullanicinin gunluk raporunu goremez', async () => {
    const users = await call('/api/admin/users', { token: adminToken });
    const other = users.body.items.find((u: { email: string }) => u.email === MANAGER.email);
    const response = await call(`/api/reports/daily?userId=${other.id}`, { token: employeeToken });
    assert.equal(response.status, 403);
  });

  test('yonetici kendi departmanindaki kullaniciyi gorebilir', async () => {
    const response = await call('/api/reports/live', { token: managerToken });
    assert.equal(response.status, 200);
    const emails = response.body.items.map((row: { email: string }) => row.email);
    assert.ok(emails.includes(EMPLOYEE.email), 'ayni departmandaki calisan gorunmeli');
    assert.ok(!emails.includes(ADMIN.email), 'baska departman gorunmemeli');
  });

  test('admin kullanici olusturur ve saatlik ucret gunceller', async () => {
    const created = await call('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Yeni Calisan',
        email: 'yeni@test.local',
        password: 'YeniParola123!',
        role: 'employee',
        department: 'Destek',
        hourlyRate: 450,
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const updated = await call(`/api/admin/users/${created.body.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { hourlyRate: 500 },
    });
    assert.equal(updated.status, 200);

    const list = await call('/api/admin/users?search=yeni@test.local', { token: adminToken });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].hourlyRate, 500);
  });

  test('ayni e-posta ile ikinci kayit 409 doner', async () => {
    const response = await call('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Kopya',
        email: 'yeni@test.local',
        password: 'YeniParola123!',
        role: 'employee',
      },
    });
    assert.equal(response.status, 409);
  });

  test('kategori kurali eklenir ve onbellek gecersiz kilinir', async () => {
    const response = await call('/api/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { matchType: 'domain', pattern: 'diziizle.test', category: 'UNPRODUCTIVE', priority: 5 },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const check = await call('/api/admin/categories/test?url=https://www.diziizle.test/bölüm-1', {
      token: adminToken,
    });
    assert.equal(check.body.category, 'UNPRODUCTIVE');
  });

  test('denetim kaydi yonetim islemlerini icerir', async () => {
    const response = await call('/api/admin/audit?limit=50', { token: adminToken });
    assert.equal(response.status, 200);
    const actions = response.body.items.map((item: { action: string }) => item.action);
    assert.ok(actions.includes('auth.login'));
    assert.ok(actions.includes('session.start'));
    assert.ok(actions.includes('screenshot.delete_by_employee'));
    assert.ok(actions.includes('payroll.export.pdf'));
  });

  test('tanimsiz uc nokta 404 ve tutarli hata formati', async () => {
    const response = await call('/api/boyle-bir-sey-yok', { token: adminToken });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'NOT_FOUND');
  });
});
