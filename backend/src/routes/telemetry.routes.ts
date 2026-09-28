/**
 * /api/telemetry - Desktop agent'in veri gonderdigi uc noktalar.
 *
 * Tasarim ilkeleri:
 *  - Idempotent: ayni batch tekrar gonderilirse mukerrer kayit olusmaz.
 *  - Sunucu otoritesi: sureler loglardan yeniden hesaplanir.
 *  - Gizlilik: yalnizca sayaclar ve pencere basligi alinir; tus icerigi asla.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { currentUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import * as activityRepo from '../repositories/activity.repo.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as screenshotRepo from '../repositories/screenshot.repo.js';
import * as userRepo from '../repositories/user.repo.js';
import * as categoryService from '../services/category.service.js';
import * as sessionService from '../services/session.service.js';
import * as storage from '../services/storage.service.js';
import { extractDomain, sampleDurationSeconds } from '../services/productivity.service.js';
import type { ActivitySample, HeartbeatInput, HeartbeatResponse } from '../types/api.js';

const DISTRACTION_THRESHOLD_SECONDS = 60;

const sampleSchema = {
  type: 'object',
  required: ['timestamp'],
  additionalProperties: false,
  properties: {
    timestamp: { type: 'string' },
    activeApp: { type: ['string', 'null'] },
    windowTitle: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] },
    domain: { type: ['string', 'null'] },
    monitorIndex: { type: 'integer', minimum: 0, maximum: 16 },
    mouseEvents: { type: 'integer', minimum: 0 },
    keyboardEvents: { type: 'integer', minimum: 0 },
    mouseDistance: { type: 'integer', minimum: 0 },
    isIdle: { type: 'boolean' },
    idleSeconds: { type: 'integer', minimum: 0 },
    durationSeconds: { type: 'integer', minimum: 0, maximum: 3600 },
  },
} as const;

export default async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /**
   * Cevrimdisi kuyruk destegi: durdurulmus bir oturum icin de, ornek oturum
   * araliginin icine (biraz toleransla) dusuyorsa kabul edilir. Boylece internet
   * kesintisinden sonra mesai kapatilsa bile bekleyen veriler kaybolmaz.
   */
  const GRACE_MS = 10 * 60 * 1000;
  const sampleBelongsToSession = (
    session: { status: string; startTime: Date; endTime: Date | null },
    timestamp: Date,
  ): boolean => {
    if (session.status === 'active') return true;
    const start = session.startTime.getTime() - GRACE_MS;
    const end = (session.endTime?.getTime() ?? session.startTime.getTime()) + GRACE_MS;
    return timestamp.getTime() >= start && timestamp.getTime() <= end;
  };

  /**
   * Agent'in calisma politikasi: esikler ve mod bilgisi tek yerden yonetilir.
   */
  app.get('/policy', async () => ({
    idleThresholdSeconds: config.rules.idleThresholdSeconds,
    distractionThresholdSeconds: DISTRACTION_THRESHOLD_SECONDS,
    screenshotBlockSeconds: config.rules.screenshotBlockSeconds,
    neutralWeight: config.rules.neutralWeight,
    serverTime: new Date().toISOString(),
  }));

  // ------------------------------------------------------------------ heartbeat
  app.post(
    '/heartbeat',
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'status'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            status: { type: 'string', enum: ['active', 'idle', 'offline'] },
            idleSeconds: { type: 'integer', minimum: 0 },
            activeApp: { type: ['string', 'null'] },
            windowTitle: { type: ['string', 'null'] },
            url: { type: ['string', 'null'] },
            projectId: { type: ['string', 'null'] },
            taskId: { type: ['string', 'null'] },
            agentVersion: { type: 'string' },
          },
        },
      },
    },
    async (request): Promise<HeartbeatResponse> => {
      const user = currentUser(request);
      const body = request.body as HeartbeatInput;
      const session = await sessionService.requireSessionForUser(body.sessionId, user.id);

      const refreshed = await sessionService.refreshLiveSession(session.id);
      const current = refreshed ?? session;

      const now = new Date();
      const idleSeconds = body.idleSeconds ?? 0;
      const agentSaysIdle = body.status === 'idle';
      const serverIdle = await sessionService.evaluateIdle(session.id, now);
      const isIdle = agentSaysIdle || serverIdle.isIdle;
      const effectiveIdleSeconds = Math.max(idleSeconds, serverIdle.idleSeconds);

      // Idle olay yasam dongusu
      const openIdle = await sessionRepo.findOpenIdleEvent(session.id);
      if (isIdle && !openIdle) {
        await sessionRepo.createIdleEvent({
          sessionId: session.id,
          userId: user.id,
          startedAt: new Date(now.getTime() - effectiveIdleSeconds * 1000),
          idleSeconds: effectiveIdleSeconds,
        });
      } else if (isIdle && openIdle) {
        // Bosluk devam ediyor: yalnizca suresi guncellenir
        await sessionRepo.updateIdleSeconds(openIdle.id, effectiveIdleSeconds);
      } else if (!isIdle && openIdle) {
        await sessionRepo.closeIdleEvent(openIdle.id, now, effectiveIdleSeconds);
      }

      // Uretken olmayan icerikte uzun kalma -> agent popup gostersin
      const unproductiveTail = await sessionService.tailUnproductiveSeconds(session.id);

      await userRepo.touchLastSeen(user.id, now);

      return {
        serverTime: now.toISOString(),
        commands: {
          promptDistraction: !isIdle && unproductiveTail >= DISTRACTION_THRESHOLD_SECONDS,
          forceIdle: isIdle && effectiveIdleSeconds >= config.rules.idleThresholdSeconds,
          stopSession: current.status !== 'active',
        },
        session: {
          id: current.id,
          totalDuration: current.totalDuration,
          idleDuration: current.idleDuration,
          status: current.status,
        },
      };
    },
  );

  // ------------------------------------------------------------------- activity
  app.post(
    '/activity',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'batch'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            agentVersion: { type: 'string' },
            batch: { type: 'array', minItems: 0, maxItems: 500, items: sampleSchema },
          },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const body = request.body as { sessionId: string; batch: ActivitySample[]; agentVersion?: string };
      const session = await sessionService.requireSessionForUser(body.sessionId, user.id);
      const samples = body.batch;

      if (session.status !== 'active') {
        const allWithinWindow = samples.every((sample) =>
          sampleBelongsToSession(session, new Date(sample.timestamp)),
        );
        if (!allWithinWindow) {
          throw badRequest(
            'Oturum kapali ve ornek zamanlari oturum araliginin disinda; once yeni oturum baslatin',
          );
        }
      }
      const categories = await categoryService.classifyMany(
        samples.map((s) => ({
          activeApp: s.activeApp ?? null,
          url: s.url ?? null,
          domain: s.domain ?? null,
          department: user.department,
          projectId: session.projectId,
        })),
      );

      const rows = samples.map((s, i) => ({
        timestamp: new Date(s.timestamp),
        activeApp: s.activeApp ?? '',
        windowTitle: s.windowTitle ?? '',
        url: s.url ?? null,
        domain: s.domain ?? extractDomain(s.url ?? null),
        monitorIndex: s.monitorIndex ?? 0,
        mouseEvents: s.mouseEvents ?? 0,
        keyboardEvents: s.keyboardEvents ?? 0,
        mouseDistance: s.mouseDistance ?? 0,
        isIdle: s.isIdle ?? false,
        idleSeconds: s.idleSeconds ?? 0,
        durationSeconds: sampleDurationSeconds(s),
        category: categories[i] ?? 'NEUTRAL',
      }));

      const invalid = rows.find((r) => Number.isNaN(r.timestamp.getTime()));
      if (invalid) throw badRequest('Gecersiz timestamp degeri');

      const result = await activityRepo.insertBatch(session.id, user.id, rows);
      const updated = await sessionService.recomputeTotals(session.id, { touchEndTime: false });

      // Idle durumunu loglardan senkronla (yalnizca acik oturumlarda)
      const anyIdle = session.status === 'active' && rows.some((r) => r.isIdle);
      const openIdle = await sessionRepo.findOpenIdleEvent(session.id);
      if (anyIdle && !openIdle) {
        const maxIdle = Math.max(...rows.filter((r) => r.isIdle).map((r) => r.idleSeconds), 0);
        await sessionRepo.createIdleEvent({
          sessionId: session.id,
          userId: user.id,
          startedAt: new Date(Date.now() - maxIdle * 1000),
          idleSeconds: maxIdle,
        });
      } else if (!anyIdle && openIdle && session.status === 'active') {
        await sessionRepo.closeIdleEvent(openIdle.id, new Date(), openIdle.idleSeconds);
      }

      const openEvents = await sessionRepo.listIdleEvents(session.id, 5);
      return {
        accepted: result.accepted,
        duplicates: result.duplicates,
        serverTime: new Date().toISOString(),
        session: updated ? sessionService.toDto(updated) : null,
        idleEvents: openEvents
          .filter((e) => e.endedAt === null)
          .map((e) => ({ id: e.id, startedAt: e.startedAt.toISOString(), idleSeconds: e.idleSeconds })),
      };
    },
  );

  // ------------------------------------------------------- screenshot presign
  app.post(
    '/screenshot/presigned-url',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'capturedAt'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            capturedAt: { type: 'string' },
            monitorIndex: { type: 'integer', minimum: 0, maximum: 16 },
            monitorName: { type: ['string', 'null'] },
            contentType: { type: 'string' },
            sizeBytes: { type: 'integer', minimum: 0 },
            blurApplied: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const body = request.body as {
        sessionId: string;
        capturedAt: string;
        monitorIndex?: number;
        monitorName?: string | null;
        contentType?: string;
        sizeBytes?: number;
        blurApplied?: boolean;
      };
      const session = await sessionService.requireSessionForUser(body.sessionId, user.id);
      const capturedAt = new Date(body.capturedAt);
      if (Number.isNaN(capturedAt.getTime())) throw badRequest('Gecersiz capturedAt');
      if (!sampleBelongsToSession(session, capturedAt)) {
        throw badRequest('Oturum kapali ve yakalama zamani oturum araliginin disinda');
      }

      const contentType = body.contentType ?? 'image/webp';
      if (!['image/webp', 'image/jpeg', 'image/png'].includes(contentType)) {
        throw badRequest('Desteklenmeyen icerik tipi');
      }

      const storageKey = storage.buildStorageKey({
        userId: user.id,
        sessionId: session.id,
        capturedAt,
        monitorIndex: body.monitorIndex ?? 0,
        contentType,
      });

      const record = await screenshotRepo.createPending({
        sessionId: session.id,
        userId: user.id,
        timestamp: capturedAt,
        storageKey,
        contentType,
        sizeBytes: body.sizeBytes ?? 0,
        monitorIndex: body.monitorIndex ?? 0,
        monitorName: body.monitorName ?? null,
        blurApplied: body.blurApplied ?? false,
      });

      const uploadUrl = await storage.presignPut(storageKey, contentType);
      return {
        screenshotId: record.id,
        storageKey,
        uploadUrl,
        expiresIn: config.s3.presignTtl,
        method: 'PUT' as const,
        headers: { 'Content-Type': contentType, 'x-amz-server-side-encryption': 'AES256' },
      };
    },
  );

  /** Yukleme tamamlandiktan sonra cagrilir; boyut ve cozunurluk kaydedilir. */
  app.post(
    '/screenshot/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['screenshotId'],
          additionalProperties: false,
          properties: {
            screenshotId: { type: 'string' },
            sizeBytes: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 0 },
            height: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const body = request.body as {
        screenshotId: string;
        sizeBytes?: number;
        width?: number;
        height?: number;
      };
      const record = await screenshotRepo.markUploaded(body.screenshotId, user.id, {
        sizeBytes: body.sizeBytes,
        width: body.width,
        height: body.height,
      });
      if (!record) throw notFound('Ekran goruntusu kaydi bulunamadi');
      return { screenshot: { ...record, storageUrl: await storage.presignGet(record.storageKey) } };
    },
  );

  // ------------------------------------------------------------- idle decision
  /**
   * Bosluk diyalogu sonucu:
   *  - 'count'   : sure calisilmis sayilir -> bosluk suresi idle_duration'dan geri eklenir
   *  - 'discard' : sure mesai disinda kalir (zaten bosluk olarak isaretli, ek islem yok)
   */
  app.post(
    '/idle-decision',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'decision'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            idleEventId: { type: ['string', 'null'] },
            decision: { type: 'string', enum: ['count', 'discard'] },
            idleSeconds: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const body = request.body as {
        sessionId: string;
        idleEventId?: string | null;
        decision: 'count' | 'discard';
        idleSeconds?: number;
      };
      const session = await sessionService.requireSessionForUser(body.sessionId, user.id);

      const event = await sessionRepo.setIdleDecision({
        id: body.idleEventId ?? undefined,
        sessionId: session.id,
        decision: body.decision,
        idleSeconds: body.idleSeconds,
      });

      let creditedSeconds = 0;
      if (body.decision === 'count') {
        const seconds = body.idleSeconds ?? event?.idleSeconds ?? 0;
        if (seconds > 0) {
          creditedSeconds = await sessionRepo.creditIdleSeconds(session.id, seconds);
        }
      }

      await auditRepo.insertAudit({
        actorId: user.id,
        actorRole: user.role,
        action: `idle.${body.decision}`,
        entityType: 'session',
        entityId: session.id,
        metadata: { idleEventId: event?.id, creditedSeconds },
        ipAddress: request.ip,
      });

      // Kredi sonrasi guncel kaydi dondur (bayat DTO gonderilmez)
      const updated = await sessionRepo.findById(session.id);
      return {
        ok: true,
        idleEvent: event,
        creditedSeconds,
        session: updated ? sessionService.toDto(updated) : null,
      };
    },
  );
}
