/** users tablosu veri erisimi. */
import { db as queryDb, query, queryOne, type Queryable } from '../db/pool.js';
import { buildUpdate, type PageParams } from '../lib/sql.js';
import type { UserRole } from '../types/api.js';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  department: string | null;
  timezone: string;
  hourlyRate: number;
  currency: string;
  agentApiKeyHash: string | null;
  isActive: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}

const COLS = `id, name, email, password_hash AS "passwordHash", role, department, timezone,
  hourly_rate AS "hourlyRate", currency, agent_api_key_hash AS "agentApiKeyHash",
  is_active AS "isActive", last_seen_at AS "lastSeenAt", created_at AS "createdAt"`;

export async function findByEmail(email: string, db: Queryable = queryDb): Promise<UserRecord | null> {
  return queryOne<UserRecord>(`SELECT ${COLS} FROM users WHERE lower(email) = lower($1)`, [email], db);
}

export async function findById(id: string, db: Queryable = queryDb): Promise<UserRecord | null> {
  return queryOne<UserRecord>(`SELECT ${COLS} FROM users WHERE id = $1`, [id], db);
}

export async function findByAgentApiKeyHash(hash: string, db: Queryable = queryDb): Promise<UserRecord | null> {
  return queryOne<UserRecord>(
    `SELECT ${COLS} FROM users WHERE agent_api_key_hash = $1 AND is_active = true`,
    [hash],
    db,
  );
}

export async function listUsers(
  filters: { role?: UserRole; department?: string; search?: string; activeOnly?: boolean },
  page: PageParams,
): Promise<{ items: UserRecord[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.role) { values.push(filters.role); where.push(`role = $${values.length}`); }
  if (filters.department) { values.push(filters.department); where.push(`department = $${values.length}`); }
  if (filters.activeOnly) where.push('is_active = true');
  if (filters.search) {
    values.push(`%${filters.search}%`);
    where.push(`(name ILIKE $${values.length} OR email ILIKE $${values.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM users ${whereSql}`,
    values,
  );
  const items = await query<UserRecord>(
    `SELECT ${COLS} FROM users ${whereSql} ORDER BY name ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, page.limit, page.offset],
  );
  return { items: items.rows, total: total?.count ?? 0 };
}

export async function createUser(
  input: {
    name: string;
    email: string;
    passwordHash: string;
    role?: UserRole;
    department?: string | null;
    timezone?: string;
    hourlyRate?: number;
    currency?: string;
  },
  db: Queryable = queryDb,
): Promise<UserRecord> {
  const row = await queryOne<UserRecord>(
    `INSERT INTO users (name, email, password_hash, role, department, timezone, hourly_rate, currency)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8)
     RETURNING ${COLS}`,
    [
      input.name,
      input.email,
      input.passwordHash,
      input.role ?? 'employee',
      input.department ?? null,
      input.timezone ?? 'Europe/Istanbul',
      input.hourlyRate ?? 0,
      input.currency ?? 'TRY',
    ],
    db,
  );
  if (!row) throw new Error('Kullanici olusturulamadi');
  return row;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  passwordHash?: string;
  role?: UserRole;
  department?: string | null;
  timezone?: string;
  hourlyRate?: number;
  currency?: string;
  isActive?: boolean;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<UserRecord | null> {
  const { clause, values } = buildUpdate({
    name: input.name,
    email: input.email,
    password_hash: input.passwordHash,
    role: input.role,
    department: input.department,
    timezone: input.timezone,
    hourly_rate: input.hourlyRate,
    currency: input.currency,
    is_active: input.isActive,
  });
  if (!clause) return findById(id);
  values.push(id);
  return queryOne<UserRecord>(
    `UPDATE users SET ${clause} WHERE id = $${values.length} RETURNING ${COLS}`,
    values,
  );
}

export async function deleteUser(id: string): Promise<boolean> {
  const res = await query('DELETE FROM users WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function setAgentApiKeyHash(id: string, hash: string | null): Promise<void> {
  await query('UPDATE users SET agent_api_key_hash = $2 WHERE id = $1', [id, hash]);
}

export async function touchLastSeen(id: string, at: Date = new Date()): Promise<void> {
  await query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [id, at]);
}

export async function listDepartments(): Promise<string[]> {
  const res = await query<{ department: string }>(
    `SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department`,
  );
  return res.rows.map((r) => r.department);
}
