/**
 * Ortam degiskenlerini okuyup dogrular. Uygulama baslarken fail-fast davranir.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const csv = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v))
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: csv('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL zorunlu'),
  DATABASE_SSL: bool(false),
  PG_POOL_MAX: int(10),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET en az 16 karakter olmali'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET en az 16 karakter olmali'),
  JWT_ACCESS_TTL: int(900),
  JWT_REFRESH_TTL: int(2_592_000),
  ALLOW_INSECURE_JWT_SECRETS: bool(false),

  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('screenshots'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_PRESIGN_TTL: int(900),
  S3_PUBLIC_BASE_URL: z.string().optional().default(''),

  /** Sirket/varsayilan saat dilimi: rapor ve bordro donemleri bu dilimde yorumlanir. */
  DEFAULT_TIMEZONE: z.string().default('Europe/Istanbul'),
  PRODUCTIVITY_NEUTRAL_WEIGHT: z.coerce.number().min(0).max(1).default(0),
  IDLE_THRESHOLD_SECONDS: int(180),
  SCREENSHOT_BLOCK_SECONDS: int(600),

  // Google Drive & Koc Hakedis
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional().default(''),
  GOOGLE_PRIVATE_KEY: z.string().optional().default(''),
  GOOGLE_DRIVE_COACHES_FOLDER_ID: z.string().optional().default(''),
});

// Test ortami icin guvenli varsayilanlar (src/test/env.mjs de ayni degerleri set eder)
if (process.env.NODE_ENV === 'test') {
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/timetracker_test';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef';
  process.env.S3_ACCESS_KEY_ID ??= 'test-key';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`[config] Gecersiz ortam degiskenleri:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

if (
  isProd &&
  !env.ALLOW_INSECURE_JWT_SECRETS &&
  (env.JWT_ACCESS_SECRET.includes('change-me') || env.JWT_REFRESH_SECRET.includes('change-me'))
) {
  // eslint-disable-next-line no-console
  console.error('[config] Uretimde varsayilan JWT secret kullanilamaz. Guvenli degerler atayin.');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  http: {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS,
  },
  db: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.PG_POOL_MAX,
  },
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
  },
  s3: {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    presignTtl: env.S3_PRESIGN_TTL,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
  },
  timezone: env.DEFAULT_TIMEZONE,
  rules: {
    neutralWeight: env.PRODUCTIVITY_NEUTRAL_WEIGHT,
    idleThresholdSeconds: env.IDLE_THRESHOLD_SECONDS,
    screenshotBlockSeconds: env.SCREENSHOT_BLOCK_SECONDS,
  },
  google: {
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.GOOGLE_PRIVATE_KEY ? env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    coachesFolderId: env.GOOGLE_DRIVE_COACHES_FOLDER_ID,
  },
} as const;

export type AppConfig = typeof config;
