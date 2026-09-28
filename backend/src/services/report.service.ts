/**
 * Raporlama servisi.
 *
 * Analitik sorgular (agregasyonlar) burada tutulur; entity CRUD'u repo
 * katmanindadir. Tum sureler saniye cinsindendir.
 */
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { overlapSeconds, secondsBetween, zonedDayRange } from '../lib/time.js';
import * as activityRepo from '../repositories/activity.repo.js';
import * as screenshotRepo from '../repositories/screenshot.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as projectRepo from '../repositories/project.repo.js';
import * as userRepo from '../repositories/user.repo.js';
import { computeProductivityScore, extractDomain, sampleDurationSeconds } from './productivity.service.js';
import { buildTimeline, summarizeTimeline, type TimelineSample } from './timeline.service.js';
import type {
  AppUsageRow,
  DailyReportRow,
  LiveStatusRow,
  MonitorStatus,
  ProductivityCategory,
  TimelineSlice,
} from '../types/api.js';

/** Agent ornekleme araligi (saniye) - "cevrimdisi" esiginde kullanilir. */
const SAMPLE_INTERVAL_SECONDS = 20;
const OFFLINE_AFTER_SECONDS = SAMPLE_INTERVAL_SECONDS * 6; // ~2 dk
const IDLE_AFTER_SECONDS = config.rules.idleThresholdSeconds;

interface UserLite {
  id: string;
  name: string;
  email: string;
  department: string | null;
  timezone: string;
}

async function loadUsers(userIds: string[] | 'all'): Promise<UserLite[]> {
  if (userIds !== 'all' && userIds.length === 0) return [];
  const res = await query<UserLite>(
    userIds === 'all'
      ? `SELECT id, name, email, department, timezone FROM users WHERE is_active = true ORDER BY name`
      : `SELECT id, name, email, department, timezone FROM users
         WHERE is_active = true AND id = ANY($1::uuid[]) ORDER BY name`,
    userIds === 'all' ? [] : [userIds],
  );
  return res.rows;
}

// ---------------------------------------------------------------- daily report

export async function dailyReport(input: {
  date: string;
  userIds: string[] | 'all';
  projectId?: string;
  timezone?: string;
}): Promise<{ date: string; rows: DailyReportRow[] }> {
  const users = await loadUsers(input.userIds);
  if (users.length === 0) return { date: input.date, rows: [] };

  const ids = users.map((u) => u.id);
  const zone = input.timezone ?? config.timezone;
  const { start, end } = zonedDayRange(input.date, zone);

  const sessions = await sessionRepo.listSessionsInRange(start, end, ids);
  const [categoryRows, screenshotCounts, dayActivity] = await Promise.all([
    query<{ userId: string; category: ProductivityCategory; seconds: number }>(
      `SELECT user_id AS "userId", category, sum(duration_seconds)::int AS seconds
       FROM activity_logs
       WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3 AND NOT is_idle
       GROUP BY user_id, category`,
      [ids, start, end],
    ),
    screenshotRepo.countByUsersInRange(ids, start, end),
    query<{ userId: string; firstAt: Date | null; lastAt: Date | null }>(
      `SELECT user_id AS "userId", min(timestamp) AS "firstAt", max(timestamp) AS "lastAt"
       FROM activity_logs
       WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3
       GROUP BY user_id`,
      [ids, start, end],
    ),
  ]);

  const categoryByUser = new Map<string, Record<ProductivityCategory, number>>();
  for (const row of categoryRows.rows) {
    const acc = categoryByUser.get(row.userId) ?? { PRODUCTIVE: 0, UNPRODUCTIVE: 0, NEUTRAL: 0 };
    acc[row.category] += row.seconds;
    categoryByUser.set(row.userId, acc);
  }
  const activityByUser = new Map(dayActivity.rows.map((r) => [r.userId, r]));

  // Oturumlarin baglı oldugu proje adlarini tek sorguda cozer
  const projectIds = [...new Set(sessions.map((s) => s.projectId).filter((id): id is string => Boolean(id)))];
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const projects = await Promise.all(projectIds.map((id) => projectRepo.findProjectById(id)));
    for (const project of projects) if (project) projectNames.set(project.id, project.name);
  }

  const rows: DailyReportRow[] = [];
  for (const user of users) {
    const userSessions = sessions.filter(
      (s) => s.userId === user.id && (!input.projectId || s.projectId === input.projectId),
    );
    if (userSessions.length === 0 && !categoryByUser.has(user.id)) continue;

    let trackedSeconds = 0;
    let idleSeconds = 0;
    let deductedSeconds = 0;
    let creditedSeconds = 0;
    let payableSeconds = 0;
    let productiveSeconds = 0;
    let unproductiveSeconds = 0;
    let neutralSeconds = 0;
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;

    for (const s of userSessions) {
      const sessionEnd = s.endTime ?? new Date();
      // Gece yarisini asan oturumlarda yalnizca o gune denk gelen kisim sayilir.
      // `sessions.total_duration` orneklerden birikmis SUREDIR (duvar saati degil),
      // bu nedenle gun icindeki pay, duvar saati orani ile olceklenir.
      const daySeconds = overlapSeconds(s.startTime, sessionEnd, start, end);
      if (daySeconds <= 0) continue;
      const wallClock = Math.max(1, secondsBetween(s.startTime, sessionEnd));
      const ratio = Math.min(1, daySeconds / wallClock);

      trackedSeconds += Math.round((s.totalDuration > 0 ? s.totalDuration : daySeconds) * ratio);
      idleSeconds += Math.round(s.idleDuration * ratio);
      deductedSeconds += Math.round(s.deductedSeconds * ratio);
      creditedSeconds += Math.round(s.creditedSeconds * ratio);
      productiveSeconds += Math.round(s.productiveSeconds * ratio);
      unproductiveSeconds += Math.round(s.unproductiveSeconds * ratio);
      neutralSeconds += Math.round(s.neutralSeconds * ratio);
      if (!firstAt || s.startTime < firstAt) firstAt = s.startTime;
      const e = sessionEnd;
      if (!lastAt || e > lastAt) lastAt = e;
    }

    // Odenebilir = takip - bosluk - silinen blok + idle diyalogunda sayilan sure
    payableSeconds = Math.max(0, trackedSeconds - idleSeconds - deductedSeconds + creditedSeconds);

    // Aktivite loglarindan kategori dagilimi (varsa daha hassas)
    const cat = categoryByUser.get(user.id);
    if (cat) {
      const catTotal = cat.PRODUCTIVE + cat.UNPRODUCTIVE + cat.NEUTRAL;
      if (catTotal > 0) {
        productiveSeconds = cat.PRODUCTIVE;
        unproductiveSeconds = cat.UNPRODUCTIVE;
        neutralSeconds = cat.NEUTRAL;
      }
    }

    const activity = activityByUser.get(user.id);
    // En cok sure harcanan proje raporlanir
    const projectSeconds = new Map<string, number>();
    for (const s of userSessions) {
      if (!s.projectId) continue;
      projectSeconds.set(s.projectId, (projectSeconds.get(s.projectId) ?? 0) + s.totalDuration);
    }
    let dominantProjectId: string | null = input.projectId ?? null;
    let bestSeconds = -1;
    for (const [id, seconds] of projectSeconds) {
      if (seconds > bestSeconds) {
        dominantProjectId = id;
        bestSeconds = seconds;
      }
    }

    rows.push({
      userId: user.id,
      userName: user.name,
      email: user.email,
      projectId: dominantProjectId,
      projectName: dominantProjectId ? (projectNames.get(dominantProjectId) ?? null) : null,
      trackedSeconds,
      activeSeconds: Math.max(0, trackedSeconds - idleSeconds),
      idleSeconds,
      deductedSeconds,
      payableSeconds,
      productiveSeconds,
      unproductiveSeconds,
      neutralSeconds,
      productivityScore: computeProductivityScore(
        { productiveSeconds, unproductiveSeconds, neutralSeconds },
        config.rules.neutralWeight,
      ),
      screenshotCount: screenshotCounts.get(user.id) ?? 0,
      firstActivityAt: activity?.firstAt?.toISOString() ?? firstAt?.toISOString() ?? null,
      lastActivityAt: activity?.lastAt?.toISOString() ?? lastAt?.toISOString() ?? null,
    });
  }

  rows.sort((a, b) => b.trackedSeconds - a.trackedSeconds);
  return { date: input.date, rows };
}

// ---------------------------------------------------------------- live status

export async function liveStatus(userIds: string[] | 'all'): Promise<LiveStatusRow[]> {
  const users = await loadUsers(userIds);
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);

  const { rows: latest } = await query<{
    userId: string;
    sessionId: string;
    timestamp: Date;
    activeApp: string | null;
    windowTitle: string | null;
    url: string | null;
    domain: string | null;
    category: ProductivityCategory;
    isIdle: boolean;
    idleSeconds: number;
  }>(
    `SELECT DISTINCT ON (user_id)
       user_id AS "userId", session_id AS "sessionId", timestamp,
       active_app AS "activeApp", window_title AS "windowTitle", url, domain,
       category, is_idle AS "isIdle", idle_seconds AS "idleSeconds"
     FROM activity_logs
     WHERE user_id = ANY($1::uuid[])
     ORDER BY user_id, timestamp DESC`,
    [ids],
  );

  const { rows: activeSessions } = await query<{
    userId: string;
    sessionId: string;
    projectName: string | null;
    taskTitle: string | null;
    startTime: Date;
    totalDuration: number;
    idleDuration: number;
  }>(
    `SELECT s.user_id AS "userId", s.id AS "sessionId", p.name AS "projectName",
            t.title AS "taskTitle", s.start_time AS "startTime",
            s.total_duration AS "totalDuration", s.idle_duration AS "idleDuration"
     FROM sessions s
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN tasks t ON t.id = s.task_id
     WHERE s.status = 'active' AND s.user_id = ANY($1::uuid[])`,
    [ids],
  );

  const seen = await query<{ id: string; lastSeenAt: Date | null }>(
    `SELECT id, last_seen_at AS "lastSeenAt" FROM users WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  const latestByUser = new Map(latest.map((r) => [r.userId, r]));
  const sessionByUser = new Map(activeSessions.map((s) => [s.userId, s]));
  const seenByUser = new Map(seen.rows.map((r) => [r.id, r.lastSeenAt]));
  const now = Date.now();

  return users.map((user) => {
    const sample = latestByUser.get(user.id);
    const session = sessionByUser.get(user.id);
    const lastSeen = seenByUser.get(user.id) ?? null;
    const ageSeconds = sample ? Math.round((now - sample.timestamp.getTime()) / 1000) : Infinity;

    let status: MonitorStatus = 'offline';
    if (sample && ageSeconds <= IDLE_AFTER_SECONDS) {
      status = sample.isIdle || sample.idleSeconds >= IDLE_AFTER_SECONDS ? 'idle' : 'active';
    } else if (sample && ageSeconds <= OFFLINE_AFTER_SECONDS) {
      status = 'idle';
    }

    return {
      userId: user.id,
      userName: user.name,
      email: user.email,
      status,
      sessionId: session?.sessionId ?? null,
      projectName: session?.projectName ?? null,
      taskTitle: session?.taskTitle ?? null,
      currentApp: sample?.activeApp ?? null,
      currentWindow: sample?.windowTitle ?? null,
      currentDomain: sample?.domain ?? extractDomain(sample?.url ?? null),
      currentCategory: sample?.category ?? null,
      sessionSeconds: session ? session.totalDuration : 0,
      idleSeconds: sample?.isIdle ? sample.idleSeconds : 0,
      lastSeenAt: lastSeen?.toISOString() ?? null,
      lastHeartbeatAt: sample ? sample.timestamp.toISOString() : null,
    };
  });
}

// ------------------------------------------------------------------ timeline

export async function timelineForUser(input: {
  userId: string;
  date: string;
  timezone?: string;
  slotMinutes?: number;
}): Promise<{
  date: string;
  slots: TimelineSlice[];
  summary: ReturnType<typeof summarizeTimeline>;
}> {
  const user = await userRepo.findById(input.userId);
  const zone = input.timezone ?? user?.timezone ?? config.timezone;
  const { start, end } = zonedDayRange(input.date, zone);

  const sessions = await sessionRepo.listSessionsInRange(start, end, [input.userId]);
  const samples: TimelineSample[] = [];

  for (const session of sessions) {
    const logs = await activityRepo.listBySession(session.id, 5000, start, end);
    for (const log of logs) {
      samples.push({
        timestamp: log.timestamp,
        isIdle: log.isIdle,
        category: log.category,
        activeApp: log.activeApp || null,
        windowTitle: log.windowTitle || null,
        url: log.url,
        domain: log.domain,
        durationSeconds: sampleDurationSeconds({ durationSeconds: log.durationSeconds }),
      });
    }
  }

  // Gizlilik protokolu: silinen ekran goruntusu bloklari mesai disi isaretlenir
  const deleted = await screenshotRepo.listDeletedInRange([input.userId], start, end);
  for (const d of deleted) {
    samples.push({
      timestamp: d.timestamp,
      isIdle: true,
      category: 'NEUTRAL',
      activeApp: null,
      windowTitle: null,
      url: null,
      domain: null,
      durationSeconds: Math.min(Math.max(d.deductedSeconds, 60), 3600),
      deducted: true,
    });
  }

  samples.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const slots = buildTimeline({
    samples,
    rangeStart: start,
    rangeEnd: end,
    slotMinutes: input.slotMinutes ?? 5,
  });

  return { date: input.date, slots, summary: summarizeTimeline(slots) };
}

// -------------------------------------------------------------- usage reports

export async function usageReport(input: {
  userIds: string[] | 'all';
  from: Date;
  to: Date;
  groupBy: 'app' | 'domain';
  limit?: number;
}): Promise<AppUsageRow[]> {
  const users = await loadUsers(input.userIds);
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);
  const rows =
    input.groupBy === 'domain'
      ? await activityRepo.domainUsage(ids, input.from, input.to)
      : await activityRepo.appUsage(ids, input.from, input.to);

  return rows.slice(0, input.limit ?? 25).map((r) => ({
    key: r.key,
    label: r.key,
    category: r.category,
    seconds: r.seconds,
    keyboardEvents: r.keyboardEvents,
    mouseEvents: r.mouseEvents,
  }));
}

// ------------------------------------------------------------ productivity

export async function productivityReport(input: {
  userIds: string[] | 'all';
  from: Date;
  to: Date;
}): Promise<{
  from: string;
  to: string;
  neutralWeight: number;
  overall: { productiveSeconds: number; unproductiveSeconds: number; neutralSeconds: number; score: number };
  users: Array<{
    userId: string;
    userName: string;
    email: string;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    totalSeconds: number;
    score: number;
  }>;
}> {
  const users = await loadUsers(input.userIds);
  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();
  if (users.length === 0) {
    return {
      from: fromIso,
      to: toIso,
      neutralWeight: config.rules.neutralWeight,
      overall: { productiveSeconds: 0, unproductiveSeconds: 0, neutralSeconds: 0, score: 0 },
      users: [],
    };
  }
  const ids = users.map((u) => u.id);
  const { rows } = await query<{ userId: string; category: ProductivityCategory; seconds: number }>(
    `SELECT user_id AS "userId", category, sum(duration_seconds)::int AS seconds
     FROM activity_logs
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3 AND NOT is_idle
     GROUP BY user_id, category`,
    [ids, fromIso, toIso],
  );

  const byUser = new Map<string, { P: number; U: number; N: number }>();
  for (const row of rows) {
    const acc = byUser.get(row.userId) ?? { P: 0, U: 0, N: 0 };
    if (row.category === 'PRODUCTIVE') acc.P += row.seconds;
    else if (row.category === 'UNPRODUCTIVE') acc.U += row.seconds;
    else acc.N += row.seconds;
    byUser.set(row.userId, acc);
  }

  const totals = [...byUser.values()].reduce(
    (acc, cur) => ({ P: acc.P + cur.P, U: acc.U + cur.U, N: acc.N + cur.N }),
    { P: 0, U: 0, N: 0 },
  );

  return {
    from: fromIso,
    to: toIso,
    neutralWeight: config.rules.neutralWeight,
    overall: {
      productiveSeconds: totals.P,
      unproductiveSeconds: totals.U,
      neutralSeconds: totals.N,
      score: computeProductivityScore(
        { productiveSeconds: totals.P, unproductiveSeconds: totals.U, neutralSeconds: totals.N },
        config.rules.neutralWeight,
      ),
    },
    users: users
      .map((u) => {
        const acc = byUser.get(u.id) ?? { P: 0, U: 0, N: 0 };
        return {
          userId: u.id,
          userName: u.name,
          email: u.email,
          productiveSeconds: acc.P,
          unproductiveSeconds: acc.U,
          neutralSeconds: acc.N,
          totalSeconds: acc.P + acc.U + acc.N,
          score: computeProductivityScore(
            { productiveSeconds: acc.P, unproductiveSeconds: acc.U, neutralSeconds: acc.N },
            config.rules.neutralWeight,
          ),
        };
      })
      .sort((a, b) => b.score - a.score || b.totalSeconds - a.totalSeconds),
  };
}
