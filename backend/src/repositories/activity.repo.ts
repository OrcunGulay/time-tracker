/** activity_logs tablosu veri erisimi. */
import { query, queryOne } from '../db/pool.js';
import type { ProductivityCategory } from '../types/api.js';

export interface ActivityInsertRow {
  timestamp: Date;
  activeApp: string;
  windowTitle: string;
  url: string | null;
  domain: string | null;
  monitorIndex: number;
  mouseEvents: number;
  keyboardEvents: number;
  mouseDistance: number;
  isIdle: boolean;
  idleSeconds: number;
  durationSeconds: number;
  category: ProductivityCategory;
}

export interface ActivitySampleRecord extends ActivityInsertRow {
  id: number;
  sessionId: string;
  userId: string;
}

/**
 * Toplu aktivite ekleme. `(session_id, timestamp)` uzerindeki unique kisit
 * sayesinde offline kuyruktan tekrar gonderilen batch'ler mukerrer kayit olusturmaz.
 */
export async function insertBatch(
  sessionId: string,
  userId: string,
  rows: readonly ActivityInsertRow[],
): Promise<{ accepted: number; duplicates: number }> {
  if (rows.length === 0) return { accepted: 0, duplicates: 0 };

  const res = await query<{ timestamp: Date }>(
    `INSERT INTO activity_logs (
        session_id, user_id, timestamp, active_app, window_title, url, domain,
        monitor_index, mouse_events, keyboard_events, mouse_distance,
        is_idle, idle_seconds, duration_seconds, category
     )
     SELECT $1, $2, t.* FROM unnest(
        $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[],
        $8::smallint[], $9::int[], $10::int[], $11::int[],
        $12::boolean[], $13::int[], $14::int[], $15::productivity_category[]
     ) AS t
     ON CONFLICT (session_id, timestamp) DO NOTHING
     RETURNING timestamp`,
    [
      sessionId,
      userId,
      rows.map((r) => r.timestamp),
      rows.map((r) => r.activeApp),
      rows.map((r) => r.windowTitle),
      rows.map((r) => r.url),
      rows.map((r) => r.domain),
      rows.map((r) => r.monitorIndex),
      rows.map((r) => r.mouseEvents),
      rows.map((r) => r.keyboardEvents),
      rows.map((r) => r.mouseDistance),
      rows.map((r) => r.isIdle),
      rows.map((r) => r.idleSeconds),
      rows.map((r) => r.durationSeconds),
      rows.map((r) => r.category),
    ],
  );

  const accepted = res.rowCount ?? 0;
  return { accepted, duplicates: rows.length - accepted };
}

export interface ActivityAggregate {
  totalSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  keyboardEvents: number;
  mouseEvents: number;
  mouseDistance: number;
  firstAt: Date | null;
  lastAt: Date | null;
  sampleCount: number;
}

/** Oturumun toplamlarini aktivite loglarindan yeniden hesaplar (sunucu otoritesi). */
export async function aggregateBySession(sessionId: string): Promise<ActivityAggregate> {
  const row = await queryOne<ActivityAggregate>(
    `SELECT
       coalesce(sum(duration_seconds), 0)::int                                   AS "totalSeconds",
       coalesce(sum(duration_seconds) FILTER (WHERE is_idle), 0)::int            AS "idleSeconds",
       coalesce(sum(duration_seconds) FILTER (WHERE NOT is_idle AND category = 'PRODUCTIVE'), 0)::int   AS "productiveSeconds",
       coalesce(sum(duration_seconds) FILTER (WHERE NOT is_idle AND category = 'UNPRODUCTIVE'), 0)::int AS "unproductiveSeconds",
       coalesce(sum(duration_seconds) FILTER (WHERE NOT is_idle AND category = 'NEUTRAL'), 0)::int      AS "neutralSeconds",
       coalesce(sum(keyboard_events), 0)::int                                    AS "keyboardEvents",
       coalesce(sum(mouse_events), 0)::int                                       AS "mouseEvents",
       coalesce(sum(mouse_distance), 0)::int                                     AS "mouseDistance",
       min(timestamp)                                                            AS "firstAt",
       max(timestamp)                                                            AS "lastAt",
       count(*)::int                                                             AS "sampleCount"
     FROM activity_logs WHERE session_id = $1`,
    [sessionId],
  );
  return (
    row ?? {
      totalSeconds: 0, idleSeconds: 0, productiveSeconds: 0, unproductiveSeconds: 0,
      neutralSeconds: 0, keyboardEvents: 0, mouseEvents: 0, mouseDistance: 0,
      firstAt: null, lastAt: null, sampleCount: 0,
    }
  );
}

export async function listBySession(
  sessionId: string,
  limit = 2000,
  after?: Date,
  before?: Date,
): Promise<ActivitySampleRecord[]> {
  const values: unknown[] = [sessionId];
  let extra = '';
  if (after) { values.push(after); extra += ` AND timestamp >= $${values.length}`; }
  if (before) { values.push(before); extra += ` AND timestamp < $${values.length}`; }
  values.push(limit);
  const res = await query<ActivitySampleRecord>(
    `SELECT id, session_id AS "sessionId", user_id AS "userId", timestamp,
            active_app AS "activeApp", window_title AS "windowTitle", url, domain,
            monitor_index AS "monitorIndex", mouse_events AS "mouseEvents",
            keyboard_events AS "keyboardEvents", mouse_distance AS "mouseDistance",
            is_idle AS "isIdle", idle_seconds AS "idleSeconds",
            duration_seconds AS "durationSeconds", category
     FROM activity_logs
     WHERE session_id = $1${extra}
     ORDER BY timestamp ASC LIMIT $${values.length}`,
    values,
  );
  return res.rows;
}

export async function lastSampleForUser(userId: string): Promise<ActivitySampleRecord | null> {
  return queryOne<ActivitySampleRecord>(
    `SELECT id, session_id AS "sessionId", user_id AS "userId", timestamp,
            active_app AS "activeApp", window_title AS "windowTitle", url, domain,
            monitor_index AS "monitorIndex", mouse_events AS "mouseEvents",
            keyboard_events AS "keyboardEvents", mouse_distance AS "mouseDistance",
            is_idle AS "isIdle", idle_seconds AS "idleSeconds",
            duration_seconds AS "durationSeconds", category
     FROM activity_logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 1`,
    [userId],
  );
}

/** En son N ornegi yeniden-eski sirali dondurur (idle/distraction zinciri icin). */
export async function recentSamples(sessionId: string, limit = 40): Promise<ActivitySampleRecord[]> {
  const res = await query<ActivitySampleRecord>(
    `SELECT id, session_id AS "sessionId", user_id AS "userId", timestamp,
            active_app AS "activeApp", window_title AS "windowTitle", url, domain,
            monitor_index AS "monitorIndex", mouse_events AS "mouseEvents",
            keyboard_events AS "keyboardEvents", mouse_distance AS "mouseDistance",
            is_idle AS "isIdle", idle_seconds AS "idleSeconds",
            duration_seconds AS "durationSeconds", category
     FROM activity_logs WHERE session_id = $1
     ORDER BY timestamp DESC LIMIT $2`,
    [sessionId, limit],
  );
  return res.rows;
}

export interface UsageRow {
  key: string;
  seconds: number;
  keyboardEvents: number;
  mouseEvents: number;
  category: ProductivityCategory;
}

/** Uygulama bazli kullanim dagilimi. */
export async function appUsage(
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<UsageRow[]> {
  const res = await query<UsageRow>(
    `SELECT active_app AS key,
            sum(duration_seconds)::int AS seconds,
            sum(keyboard_events)::int  AS "keyboardEvents",
            sum(mouse_events)::int     AS "mouseEvents",
            mode() WITHIN GROUP (ORDER BY category) AS category
     FROM activity_logs
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3
       AND active_app <> '' AND NOT is_idle
     GROUP BY active_app
     ORDER BY seconds DESC`,
    [userIds, from, to],
  );
  return res.rows;
}

/** Domain bazli kullanim dagilimi. */
export async function domainUsage(
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<UsageRow[]> {
  const res = await query<UsageRow>(
    `SELECT domain AS key,
            sum(duration_seconds)::int AS seconds,
            sum(keyboard_events)::int  AS "keyboardEvents",
            sum(mouse_events)::int     AS "mouseEvents",
            mode() WITHIN GROUP (ORDER BY category) AS category
     FROM activity_logs
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3
       AND domain IS NOT NULL AND domain <> '' AND NOT is_idle
     GROUP BY domain
     ORDER BY seconds DESC`,
    [userIds, from, to],
  );
  return res.rows;
}

/** Uretkenlik skoru icin kategori bazli saniye toplamlari. */
export async function categoryTotals(
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Array<{ category: ProductivityCategory; seconds: number }>> {
  const res = await query<{ category: ProductivityCategory; seconds: number }>(
    `SELECT category, sum(duration_seconds)::int AS seconds
     FROM activity_logs
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3 AND NOT is_idle
     GROUP BY category`,
    [userIds, from, to],
  );
  return res.rows;
}

export async function countSamples(userId: string, from: Date, to: Date): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM activity_logs
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp < $3`,
    [userId, from, to],
  );
  return row?.count ?? 0;
}
