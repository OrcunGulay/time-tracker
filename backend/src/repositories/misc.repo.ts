/** audit_logs ve refresh_tokens tablolari veri erisimi. */
import { db as queryDb, query, queryOne, type Queryable } from '../db/pool.js';
import type { PageParams } from '../lib/sql.js';
import type { UserRole } from '../types/api.js';

// ---------------------------------------------------------------- audit_logs

export interface AuditRecord {
  id: number;
  actorId: string | null;
  actorRole: UserRole | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: Date;
}

export async function insertAudit(
  input: {
    actorId?: string | null;
    actorRole?: UserRole | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  },
  db: Queryable = queryDb,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      input.actorId ?? null,
      input.actorRole ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ipAddress ?? null,
    ],
  );
}

const AUDIT_COLS = `id, actor_id AS "actorId", actor_role AS "actorRole", action,
  entity_type AS "entityType", entity_id AS "entityId", metadata, ip_address AS "ipAddress",
  created_at AS "createdAt"`;

export async function listAudit(
  filters: { actorId?: string; action?: string; entityType?: string; from?: Date; to?: Date },
  page: PageParams,
): Promise<{ items: AuditRecord[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.actorId) { values.push(filters.actorId); where.push(`actor_id = $${values.length}`); }
  if (filters.action) { values.push(filters.action); where.push(`action = $${values.length}`); }
  if (filters.entityType) { values.push(filters.entityType); where.push(`entity_type = $${values.length}`); }
  if (filters.from) { values.push(filters.from); where.push(`created_at >= $${values.length}`); }
  if (filters.to) { values.push(filters.to); where.push(`created_at < $${values.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM audit_logs ${whereSql}`, values);
  const rows = await query<AuditRecord>(
    `SELECT ${AUDIT_COLS} FROM audit_logs ${whereSql}
     ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, page.limit, page.offset],
  );
  return { items: rows.rows, total: total?.count ?? 0 };
}

// ------------------------------------------------------------ refresh_tokens

export async function storeRefreshToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [input.userId, input.tokenHash, input.expiresAt, input.userAgent ?? null],
  );
}

export async function findValidRefreshToken(
  tokenHash: string,
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  return queryOne<{ id: string; userId: string; expiresAt: Date }>(
    `SELECT id, user_id AS "userId", expires_at AS "expiresAt" FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function purgeExpiredTokens(): Promise<number> {
  const res = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days'`,
  );
  return res.rowCount ?? 0;
}
