/** sessions ve idle_events tablolari veri erisimi. */
import { db as queryDb, query, queryOne, type Queryable } from '../db/pool.js';
import { buildUpdate, type PageParams } from '../lib/sql.js';
import type { IdleDecision, SessionStatus } from '../types/api.js';

export interface SessionRecord {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  startTime: Date;
  endTime: Date | null;
  totalDuration: number;
  idleDuration: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  deductedSeconds: number;
  creditedSeconds: number;
  status: SessionStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  clientStartedAt: Date | null;
  clientInfo: Record<string, unknown>;
}

const COLS = `id, user_id AS "userId", project_id AS "projectId", task_id AS "taskId",
  start_time AS "startTime", end_time AS "endTime", total_duration AS "totalDuration",
  idle_duration AS "idleDuration", productive_seconds AS "productiveSeconds",
  unproductive_seconds AS "unproductiveSeconds", neutral_seconds AS "neutralSeconds",
  deducted_seconds AS "deductedSeconds", credited_seconds AS "creditedSeconds",
  status, approved_by AS "approvedBy",
  approved_at AS "approvedAt", client_started_at AS "clientStartedAt",
  coalesce(client_info, '{}'::jsonb) AS "clientInfo"`;

export async function findById(id: string, db: Queryable = queryDb): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>(`SELECT ${COLS} FROM sessions WHERE id = $1`, [id], db);
}

export async function findActiveByUser(userId: string, db: Queryable = queryDb): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>(
    `SELECT ${COLS} FROM sessions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId],
    db,
  );
}

export async function startSession(input: {
  userId: string;
  projectId?: string | null;
  taskId?: string | null;
  startTime: Date;
  clientStartedAt?: Date | null;
  clientInfo?: Record<string, unknown>;
}): Promise<SessionRecord> {
  const row = await queryOne<SessionRecord>(
    `INSERT INTO sessions (user_id, project_id, task_id, start_time, client_started_at, client_info, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active')
     RETURNING ${COLS}`,
    [
      input.userId,
      input.projectId ?? null,
      input.taskId ?? null,
      input.startTime,
      input.clientStartedAt ?? input.startTime,
      JSON.stringify(input.clientInfo ?? {}),
    ],
  );
  if (!row) throw new Error('Oturum baslatilamadi');
  return row;
}

export async function stopSession(
  id: string,
  endTime: Date,
  totals: {
    totalDuration: number;
    idleDuration: number;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
  },
): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>(
    `UPDATE sessions SET
       end_time = $2,
       total_duration = $3,
       idle_duration = $4,
       productive_seconds = $5,
       unproductive_seconds = $6,
       neutral_seconds = $7,
       status = 'stopped'
     WHERE id = $1
     RETURNING ${COLS}`,
    [
      id,
      endTime,
      totals.totalDuration,
      totals.idleDuration,
      totals.productiveSeconds,
      totals.unproductiveSeconds,
      totals.neutralSeconds,
    ],
  );
}

export async function updateTotals(
  id: string,
  totals: Partial<{
    totalDuration: number;
    idleDuration: number;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    endTime: Date | null;
  }>,
): Promise<SessionRecord | null> {
  const { clause, values } = buildUpdate({
    total_duration: totals.totalDuration,
    idle_duration: totals.idleDuration,
    productive_seconds: totals.productiveSeconds,
    unproductive_seconds: totals.unproductiveSeconds,
    neutral_seconds: totals.neutralSeconds,
    end_time: totals.endTime,
  });
  if (!clause) return findById(id);
  values.push(id);
  return queryOne<SessionRecord>(
    `UPDATE sessions SET ${clause} WHERE id = $${values.length} RETURNING ${COLS}`,
    values,
  );
}

/** Ekran goruntusu silindiginde mesai suresinden dusulen blok. */
export async function addDeductedSeconds(id: string, seconds: number): Promise<void> {
  await query('UPDATE sessions SET deducted_seconds = deducted_seconds + $2 WHERE id = $1', [id, seconds]);
}

/**
 * Idle diyalogunda "calisilmis say" secildiginde boslugu geri ekler.
 *
 * `idle_duration` DEGISTIRILMEZ (teshis/denetim icin gercek bosluk korunur);
 * yalnizca `credited_seconds` artirilir ve odenebilir sure formulunde eklenir:
 *     payable = total - idle - deducted + credited
 *
 * Guard: toplam kredi, kaydedilmis bosluk suresini asamaz (cift sayim olmaz).
 * Gercekte eklenen miktar (delta) dondurulur.
 */
export async function creditIdleSeconds(id: string, seconds: number): Promise<number> {
  const row = await queryOne<{ credited: number }>(
    `WITH before AS (
       SELECT id, idle_duration, credited_seconds FROM sessions WHERE id = $1 FOR UPDATE
     )
     UPDATE sessions s
        SET credited_seconds = LEAST(b.idle_duration, b.credited_seconds + $2)
       FROM before b
      WHERE s.id = b.id
     RETURNING (LEAST(b.idle_duration, b.credited_seconds + $2) - b.credited_seconds)::int AS credited`,
    [id, seconds],
  );
  return row?.credited ?? 0;
}

export async function setApproval(
  id: string,
  status: 'approved' | 'rejected',
  approvedBy: string,
): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>(
    `UPDATE sessions SET status = $2, approved_by = $3, approved_at = now()
     WHERE id = $1 AND status = 'stopped'
     RETURNING ${COLS}`,
    [id, status, approvedBy],
  );
}

export interface SessionListFilters {
  userId?: string;
  projectId?: string;
  status?: SessionStatus;
  from?: Date;
  to?: Date;
}

export async function listSessions(
  filters: SessionListFilters,
  page: PageParams,
): Promise<{ items: SessionRecord[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.userId) { values.push(filters.userId); where.push(`user_id = $${values.length}`); }
  if (filters.projectId) { values.push(filters.projectId); where.push(`project_id = $${values.length}`); }
  if (filters.status) { values.push(filters.status); where.push(`status = $${values.length}`); }
  if (filters.from) { values.push(filters.from); where.push(`start_time >= $${values.length}`); }
  if (filters.to) { values.push(filters.to); where.push(`start_time < $${values.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM sessions ${whereSql}`, values);
  const rows = await query<SessionRecord>(
    `SELECT ${COLS} FROM sessions ${whereSql} ORDER BY start_time DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, page.limit, page.offset],
  );
  return { items: rows.rows, total: total?.count ?? 0 };
}

/** Raporlama icin: araliga degiyor olan oturumlar (gece yarisi kesismeleri dahil). */
export async function listSessionsInRange(
  from: Date,
  to: Date,
  userIds: readonly string[] = [],
): Promise<SessionRecord[]> {
  const values: unknown[] = [from, to];
  let extra = '';
  if (userIds.length > 0) {
    values.push(userIds);
    extra = ` AND user_id = ANY($3::uuid[])`;
  }
  const res = await query<SessionRecord>(
    `SELECT ${COLS} FROM sessions
     WHERE start_time < $2 AND coalesce(end_time, now()) > $1${extra}
     ORDER BY start_time ASC`,
    values,
  );
  return res.rows;
}

// ----------------------------------------------------------------- idle_events

export interface IdleEventRecord {
  id: string;
  sessionId: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  idleSeconds: number;
  decision: IdleDecision | null;
  decidedAt: Date | null;
}

const IDLE_COLS = `id, session_id AS "sessionId", user_id AS "userId", started_at AS "startedAt",
  ended_at AS "endedAt", idle_seconds AS "idleSeconds", decision, decided_at AS "decidedAt"`;

export async function findOpenIdleEvent(
  sessionId: string,
  db: Queryable = queryDb,
): Promise<IdleEventRecord | null> {
  return queryOne<IdleEventRecord>(
    `SELECT ${IDLE_COLS} FROM idle_events
     WHERE session_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [sessionId],
    db,
  );
}

export async function createIdleEvent(input: {
  sessionId: string;
  userId: string;
  startedAt: Date;
  idleSeconds: number;
}): Promise<IdleEventRecord> {
  const row = await queryOne<IdleEventRecord>(
    `INSERT INTO idle_events (session_id, user_id, started_at, idle_seconds)
     VALUES ($1, $2, $3, $4) RETURNING ${IDLE_COLS}`,
    [input.sessionId, input.userId, input.startedAt, input.idleSeconds],
  );
  if (!row) throw new Error('Idle kaydi olusturulamadi');
  return row;
}

export async function closeIdleEvent(
  id: string,
  endedAt: Date,
  idleSeconds: number,
): Promise<IdleEventRecord | null> {
  return queryOne<IdleEventRecord>(
    `UPDATE idle_events SET ended_at = $2, idle_seconds = GREATEST(idle_seconds, $3)
     WHERE id = $1 RETURNING ${IDLE_COLS}`,
    [id, endedAt, idleSeconds],
  );
}

export async function setIdleDecision(
  input: { id?: string; sessionId?: string; decision: IdleDecision; idleSeconds?: number },
): Promise<IdleEventRecord | null> {
  if (input.id) {
    return queryOne<IdleEventRecord>(
      `UPDATE idle_events SET decision = $2, decided_at = now(),
         idle_seconds = coalesce($3, idle_seconds)
       WHERE id = $1 RETURNING ${IDLE_COLS}`,
      [input.id, input.decision, input.idleSeconds ?? null],
    );
  }
  return queryOne<IdleEventRecord>(
    `UPDATE idle_events SET decision = $2, decided_at = now()
     WHERE id = (
       SELECT id FROM idle_events WHERE session_id = $1 AND decision IS NULL
       ORDER BY started_at DESC LIMIT 1
     ) RETURNING ${IDLE_COLS}`,
    [input.sessionId, input.decision],
  );
}

export async function updateIdleSeconds(id: string, idleSeconds: number): Promise<void> {
  await query(
    `UPDATE idle_events SET idle_seconds = GREATEST(idle_seconds, $2) WHERE id = $1 AND ended_at IS NULL`,
    [id, idleSeconds],
  );
}

export async function listIdleEvents(sessionId: string, limit = 100): Promise<IdleEventRecord[]> {
  const res = await query<IdleEventRecord>(
    `SELECT ${IDLE_COLS} FROM idle_events WHERE session_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [sessionId, limit],
  );
  return res.rows;
}

/** Karari verilmeyen idle olaylarin suresini bosluk sayisina ekler. */
export async function undecidedIdleSeconds(sessionId: string): Promise<number> {
  const row = await queryOne<{ seconds: number }>(
    `SELECT coalesce(sum(idle_seconds), 0)::int AS seconds FROM idle_events
     WHERE session_id = $1 AND decision IS NULL`,
    [sessionId],
  );
  return row?.seconds ?? 0;
}
