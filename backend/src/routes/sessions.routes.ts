/** /api/sessions - mesai oturumu baslat/durdur/listele/onayla. */
import type { FastifyInstance } from 'fastify';
import { queryOne } from '../db/pool.js';
import { currentUser } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { normalizePage } from '../lib/sql.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as idleRepo from '../repositories/session.repo.js';
import * as sessionService from '../services/session.service.js';
import type { SessionStatus } from '../types/api.js';

const startBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: ['string', 'null'] },
    taskId: { type: ['string', 'null'] },
    clientStartedAt: { type: ['string', 'null'] },
    clientInfo: { type: 'object', additionalProperties: true },
  },
} as const;

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.post('/start', { schema: { body: startBody } }, async (request) => {
    const user = currentUser(request);
    const body = (request.body ?? {}) as {
      projectId?: string | null;
      taskId?: string | null;
      clientStartedAt?: string | null;
      clientInfo?: Record<string, unknown>;
    };
    const session = await sessionService.startSession(user, body);
    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'session.start',
      entityType: 'session',
      entityId: session.id,
      metadata: { projectId: session.projectId, taskId: session.taskId },
      ipAddress: request.ip,
    });
    return { session };
  });

  app.post(
    '/stop',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { sessionId: { type: 'string' }, endedAt: { type: ['string', 'null'] } },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const body = (request.body ?? {}) as { sessionId?: string; endedAt?: string | null };

      // Oturum id'si verilmemisse aktif oturumu bul (tray'den tek tikla durdurma)
      const session = body.sessionId
        ? await sessionService.requireSessionForUser(body.sessionId, user.id)
        : await sessionRepo.findActiveByUser(user.id);
      if (!session) throw notFound('Aktif oturum yok');
      if (session.status !== 'active') throw badRequest('Oturum zaten kapatilmis');

      const endedAt = body.endedAt ? new Date(body.endedAt) : new Date();
      if (Number.isNaN(endedAt.getTime())) throw badRequest('Gecersiz endedAt');

      const dto = await sessionService.stopSession(session, endedAt);
      // Acik kalan idle olayi varsa sureci kapat
      const openIdle = await idleRepo.findOpenIdleEvent(session.id);
      if (openIdle) await idleRepo.closeIdleEvent(openIdle.id, endedAt, openIdle.idleSeconds);

      await auditRepo.insertAudit({
        actorId: user.id,
        actorRole: user.role,
        action: 'session.stop',
        entityType: 'session',
        entityId: session.id,
        metadata: { totalDuration: dto.totalDuration, idleDuration: dto.idleDuration },
        ipAddress: request.ip,
      });
      return { session: dto };
    },
  );

  app.get('/current', async (request) => {
    const user = currentUser(request);
    return { session: await sessionService.getActiveSession(user.id) };
  });

  app.get('/', async (request) => {
    const user = currentUser(request);
    const query = request.query as Record<string, string | undefined>;
    const page = normalizePage(query);

    // Calisan yalnizca kendi oturumlarini gorebilir; yoneticiler filtre verebilir.
    const requestedUserId = user.role === 'employee' ? user.id : query.userId;
    const filters: sessionRepo.SessionListFilters = {
      userId: requestedUserId,
      projectId: query.projectId,
      status: query.status as SessionStatus | undefined,
    };
    if (query.from) filters.from = new Date(query.from);
    if (query.to) filters.to = new Date(query.to);

    if (user.role === 'manager' && requestedUserId) {
      const { assertCanAccessUser } = await import('../lib/scope.js');
      await assertCanAccessUser(user, requestedUserId);
    }

    const { items, total } = await sessionRepo.listSessions(filters, page);
    return {
      items: items.map(sessionService.toDto),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.get('/:id', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const session = await sessionRepo.findById(id);
    if (!session) throw notFound('Oturum bulunamadi');
    if (session.userId !== user.id && user.role === 'employee') {
      throw forbidden('Bu oturumu gorme yetkiniz yok');
    }
    const idleEvents = await idleRepo.listIdleEvents(id);
    const summary = await queryOne<{ totalSeconds: number; idleSeconds: number }>(
      `SELECT coalesce(sum(duration_seconds), 0)::int AS "totalSeconds",
              coalesce(sum(duration_seconds) FILTER (WHERE is_idle), 0)::int AS "idleSeconds"
       FROM activity_logs WHERE session_id = $1`,
      [id],
    );
    return {
      session: sessionService.toDto(session),
      idleEvents,
      activitySummary: summary ?? { totalSeconds: 0, idleSeconds: 0 },
    };
  });

  /** Yonetici onayi: bordroya esas saatler. */
  app.post('/:id/approve', { preHandler: app.requireRole('admin', 'manager') }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const { status } = (request.body ?? {}) as { status?: 'approved' | 'rejected' };
    const updated = await sessionRepo.setApproval(id, status === 'rejected' ? 'rejected' : 'approved', user.id);
    if (!updated) throw badRequest('Oturum onaylanabilir durumda degil (durdurulmus olmali)');
    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: `session.${status === 'rejected' ? 'reject' : 'approve'}`,
      entityType: 'session',
      entityId: id,
      ipAddress: request.ip,
    });
    return { session: sessionService.toDto(updated) };
  });
}
