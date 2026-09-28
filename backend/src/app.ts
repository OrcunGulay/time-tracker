/** Fastify uygulama fabrikasi (test edilebilirlik icin ayri tutulur). */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { registerAuth } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import adminRoutes from './routes/admin.routes.js';
import authRoutes from './routes/auth.routes.js';
import payrollRoutes from './routes/payroll.routes.js';
import reportRoutes from './routes/reports.routes.js';
import screenshotRoutes from './routes/screenshots.routes.js';
import sessionRoutes from './routes/sessions.routes.js';
import telemetryRoutes from './routes/telemetry.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: config.http.logLevel,
          transport: config.isProd
            ? undefined
            : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
    trustProxy: true,
    // Agent batch'leri ve PDF yanitlari icin makul ust sinir
    bodyLimit: 4 * 1024 * 1024,
    disableRequestLogging: config.isProd,
  });

  await app.register(cors, {
    origin: config.http.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Test ortaminda limitler devre disi
    global: !config.isTest,
  });

  registerAuth(app);

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & {
      statusCode?: number;
      code?: string;
      validation?: Array<{
        instancePath?: string;
        params?: { missingProperty?: string };
        message: string;
      }>;
    };
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    // Fastify sema dogrulama hatasi
    if (error.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Istek dogrulanamadi',
        details: error.validation.map((v) => ({
          path: v.instancePath || v.params?.missingProperty || '(root)',
          message: v.message,
        })),
      });
    }

    // PostgreSQL hata kodlari
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505') {
      return reply.status(409).send({ error: 'CONFLICT', message: 'Kayit zaten mevcut' });
    }
    if (pgCode === '23503') {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Iliskili kayit bulunamadi' });
    }
    if (pgCode === '22P02') {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Gecersiz parametre formati' });
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: 'CLIENT_ERROR',
        message: error.message,
      });
    }

    request.log.error({ err: error }, 'Beklenmeyen hata');
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: config.isProd ? 'Sunucu hatasi' : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: 'NOT_FOUND',
      message: `Uc nokta bulunamadi: ${request.method} ${request.url}`,
    }),
  );

  app.get('/health', async () => ({
    status: 'ok',
    env: config.env,
    time: new Date().toISOString(),
  }));

  app.get('/health/db', async (_request, reply) => {
    try {
      const { queryOne } = await import('./db/pool.js');
      const row = await queryOne<{ now: Date }>('SELECT now() AS now');
      return { status: 'ok', dbTime: row?.now ?? null };
    } catch (err) {
      return reply.status(503).send({ status: 'error', message: (err as Error).message });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(sessionRoutes, { prefix: '/api/sessions' });
  await app.register(telemetryRoutes, { prefix: '/api/telemetry' });
  await app.register(screenshotRoutes, { prefix: '/api/screenshots' });
  await app.register(reportRoutes, { prefix: '/api/reports' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(payrollRoutes, { prefix: '/api/payroll' });

  return app;
}
