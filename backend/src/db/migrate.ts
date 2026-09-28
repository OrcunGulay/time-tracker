/**
 * Basit, bagimliliksiz SQL migration runner.
 *   npm run migrate
 * sql/ altindaki *.sql dosyalarini ada gore sirali uygular ve schema_migrations
 * tablosunda takip eder. Her dosya tek bir transaction icinde calisir.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(__dirname, '../../sql');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(log = console.log): Promise<string[]> {
  await ensureMigrationsTable();
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const freshlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      freshlyApplied.push(file);
      log(`[migrate] uygulandi: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`[migrate] ${file} basarisiz: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  if (freshlyApplied.length === 0) log('[migrate] guncel, yeni migration yok.');
  return freshlyApplied;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isDirectRun) {
  runMigrations()
    .then(async (applied) => {
      console.log(`[migrate] toplam ${applied.length} migration uygulandi.`);
      await closePool();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
