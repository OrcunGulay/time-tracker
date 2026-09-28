/** screenshots tablosu veri erisimi. */
import { db as queryDb, query, queryOne, type Queryable } from '../db/pool.js';
import type { PageParams } from '../lib/sql.js';

export interface ScreenshotRecord {
  id: string;
  sessionId: string;
  userId: string;
  timestamp: Date;
  storageKey: string;
  storageUrl: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  monitorIndex: number;
  monitorName: string | null;
  blurApplied: boolean;
  deletedByEmployee: boolean;
  deletedAt: Date | null;
  deductedSeconds: number;
  uploadedAt: Date | null;
}

const COLS = `id, session_id AS "sessionId", user_id AS "userId", timestamp,
  storage_key AS "storageKey", storage_url AS "storageUrl", content_type AS "contentType",
  size_bytes AS "sizeBytes", width, height, monitor_index AS "monitorIndex",
  monitor_name AS "monitorName", blur_applied AS "blurApplied",
  deleted_by_employee AS "deletedByEmployee", deleted_at AS "deletedAt",
  deducted_seconds AS "deductedSeconds", uploaded_at AS "uploadedAt"`;

export async function createPending(input: {
  sessionId: string;
  userId: string;
  timestamp: Date;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  monitorIndex: number;
  monitorName: string | null;
  blurApplied: boolean;
}): Promise<ScreenshotRecord> {
  const row = await queryOne<ScreenshotRecord>(
    `INSERT INTO screenshots (
       session_id, user_id, timestamp, storage_key, content_type, size_bytes,
       monitor_index, monitor_name, blur_applied
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (session_id, timestamp, monitor_index) DO UPDATE
       SET storage_key = EXCLUDED.storage_key,
           content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes,
           blur_applied = EXCLUDED.blur_applied,
           monitor_name = EXCLUDED.monitor_name
     RETURNING ${COLS}`,
    [
      input.sessionId,
      input.userId,
      input.timestamp,
      input.storageKey,
      input.contentType,
      input.sizeBytes,
      input.monitorIndex,
      input.monitorName,
      input.blurApplied,
    ],
  );
  if (!row) throw new Error('Ekran goruntusu kaydi olusturulamadi');
  return row;
}

export async function markUploaded(
  id: string,
  userId: string,
  details: { sizeBytes?: number; width?: number; height?: number; storageUrl?: string | null },
): Promise<ScreenshotRecord | null> {
  return queryOne<ScreenshotRecord>(
    `UPDATE screenshots SET
       uploaded_at = now(),
       size_bytes = coalesce($3, size_bytes),
       width = coalesce($4, width),
       height = coalesce($5, height),
       storage_url = coalesce($6, storage_url)
     WHERE id = $1 AND user_id = $2
     RETURNING ${COLS}`,
    [id, userId, details.sizeBytes ?? null, details.width ?? null, details.height ?? null, details.storageUrl ?? null],
  );
}

export async function findById(id: string, db: Queryable = queryDb): Promise<ScreenshotRecord | null> {
  return queryOne<ScreenshotRecord>(`SELECT ${COLS} FROM screenshots WHERE id = $1`, [id], db);
}

/** Gizlilik protokolu: calisan kendi gorselini sildiginde yumusak silme. */
export async function softDeleteByEmployee(
  id: string,
  userId: string,
  deductedSeconds: number,
): Promise<ScreenshotRecord | null> {
  return queryOne<ScreenshotRecord>(
    `UPDATE screenshots SET
       deleted_by_employee = true,
       deleted_at = now(),
       deducted_seconds = $3,
       storage_key = ''
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING ${COLS}`,
    [id, userId, deductedSeconds],
  );
}

export interface ScreenshotListFilters {
  userId?: string;
  sessionId?: string;
  from?: Date;
  to?: Date;
  includeDeleted?: boolean;
  monitorIndex?: number;
}

export async function list(
  filters: ScreenshotListFilters,
  page: PageParams,
): Promise<{ items: ScreenshotRecord[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (!filters.includeDeleted) where.push('deleted_at IS NULL');
  if (filters.userId) { values.push(filters.userId); where.push(`user_id = $${values.length}`); }
  if (filters.sessionId) { values.push(filters.sessionId); where.push(`session_id = $${values.length}`); }
  if (filters.from) { values.push(filters.from); where.push(`timestamp >= $${values.length}`); }
  if (filters.to) { values.push(filters.to); where.push(`timestamp < $${values.length}`); }
  if (filters.monitorIndex !== undefined) { values.push(filters.monitorIndex); where.push(`monitor_index = $${values.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM screenshots ${whereSql}`,
    values,
  );
  const rows = await query<ScreenshotRecord>(
    `SELECT ${COLS} FROM screenshots ${whereSql}
     ORDER BY timestamp DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, page.limit, page.offset],
  );
  return { items: rows.rows, total: total?.count ?? 0 };
}

/** Rapor icin: araliktaki silinmis kayitlarin zaman damgalari (timeline isaretlemesi). */
export async function listDeletedInRange(
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Array<{ userId: string; timestamp: Date; deductedSeconds: number }>> {
  const res = await query<{ userId: string; timestamp: Date; deductedSeconds: number }>(
    `SELECT user_id AS "userId", timestamp, deducted_seconds AS "deductedSeconds"
     FROM screenshots
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3 AND deleted_at IS NOT NULL`,
    [userIds, from, to],
  );
  return res.rows;
}

export async function countInRange(userId: string, from: Date, to: Date): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM screenshots
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp < $3 AND deleted_at IS NULL`,
    [userId, from, to],
  );
  return row?.count ?? 0;
}

export async function countByUsersInRange(
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const res = await query<{ userId: string; count: number }>(
    `SELECT user_id AS "userId", count(*)::int AS count FROM screenshots
     WHERE user_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3 AND deleted_at IS NULL
     GROUP BY user_id`,
    [userIds, from, to],
  );
  return new Map(res.rows.map((r) => [r.userId, r.count]));
}
