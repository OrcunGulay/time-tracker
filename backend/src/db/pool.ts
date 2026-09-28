/**
 * PostgreSQL baglanti havuzu ve sorgu yardimcilari.
 */
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// numeric(12,2) -> number (JS'de string donmesini engeller)
pg.types.setTypeParser(1700, (v: string) => (v === null ? null : Number.parseFloat(v)));
// bigint -> number (count(*), bigserial)
pg.types.setTypeParser(20, (v: string) => (v === null ? null : Number.parseInt(v, 10)));

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // Bos bir client pool'da hata firlatirsa surec cokmesin
  console.error('[db] beklenmeyen havuz hatasi:', err.message);
});

/** Hem Pool hem PoolClient ile calisabilen minimal arayuz. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, values as never);
}

/** Havuzu Queryable olarak sunar (transaction client'i de ayni arayuzdedir). */
export const db: Queryable = {
  query: (text: string, values?: unknown[]) => query(text, values),
};

/** Tek satir dondurur, yoksa null. */
export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
  db: Queryable = pool,
): Promise<R | null> {
  const res = await db.query<R>(text, values);
  return res.rows[0] ?? null;
}

/** Atomik islem. Callback hata firlatirsa ROLLBACK edilir. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* yoksay */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Test/seed icin: semayi sifirlar. Yalnizca development/test ortaminda calisir. */
export async function truncateAll(db: Queryable = pool): Promise<void> {
  if (config.isProd) throw new Error('truncateAll uretimde cagirilamaz');
  await db.query(
    `TRUNCATE activity_logs, screenshots, idle_events, sessions, payroll_runs,
     refresh_tokens, audit_logs, category_rules, project_members, tasks, projects, users
     RESTART IDENTITY CASCADE`,
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
