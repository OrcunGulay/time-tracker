/**
 * Test on yukleyicisi: config.ts zorunlu degiskenleri fail-fast dogruladigi icin
 * test ortaminda guvenli varsayilanlari burada set ediyoruz.
 *
 * Kullanim: node --import tsx --import ./src/test/env.mjs --test ...
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/timetracker_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef';
process.env.S3_ACCESS_KEY_ID ??= 'test-key';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'screenshots-test';
// Rapor ve bordro donemleri testte deterministik olsun diye UTC kullanilir
process.env.DEFAULT_TIMEZONE ??= 'UTC';
process.env.LOG_LEVEL ??= 'fatal';
