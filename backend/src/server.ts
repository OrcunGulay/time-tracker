/** Sunucu giris noktasi. */
import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { purgeExpiredTokens } from './repositories/misc.repo.js';

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS !== 'true') {
    await runMigrations((msg) => console.log(msg));
  }

  const app = await buildApp();

  // Suresi gecmis yenileme tokenlarini gunluk temizle
  const purge = setInterval(
    () => {
      void purgeExpiredTokens().catch((err: Error) =>
        console.warn('[cleanup] token temizligi basarisiz:', err.message),
      );
    },
    24 * 60 * 60 * 1000,
  );
  purge.unref();

  await app.listen({ host: config.http.host, port: config.http.port });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} alindi, kapatiliyor...`);
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Kapatma hatasi');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Islenmeyen promise hatasi');
  });
}

main().catch((err: unknown) => {
  console.error('[server] baslatilamadi:', err instanceof Error ? err.message : err);
  process.exit(1);
});
