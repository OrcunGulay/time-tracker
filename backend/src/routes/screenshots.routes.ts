/**
 * /api/screenshots - ekran goruntusu galerisi ve gizlilik (silme) protokolu.
 *
 * Onemli is kurali: calisan kendi yakalanmis karesini sildiginde, o karenin
 * ait oldugu blok (varsayilan 10 dk) mesai suresinden dusulur ve denetim
 * kaydina yazilir. Bu, "sil ve yerine bosluk birak" yaklasimidir.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { currentUser } from '../lib/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { assertCanAccessUser } from '../lib/scope.js';
import { normalizePage } from '../lib/sql.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as screenshotRepo from '../repositories/screenshot.repo.js';
import * as sessionRepo from '../repositories/session.repo.js';
import * as sessionService from '../services/session.service.js';
import * as storage from '../services/storage.service.js';

export default async function screenshotRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const page = normalizePage(q);

    const requestedUserId = user.role === 'employee' ? user.id : q.userId;
    if (requestedUserId && user.role === 'manager') {
      await assertCanAccessUser(user, requestedUserId);
    }

    const filters: screenshotRepo.ScreenshotListFilters = {
      userId: requestedUserId,
      sessionId: q.sessionId,
      includeDeleted: q.includeDeleted === 'true',
    };
    if (q.from) filters.from = new Date(q.from);
    if (q.to) filters.to = new Date(q.to);
    if (q.monitorIndex !== undefined) filters.monitorIndex = Number(q.monitorIndex);

    const { items, total } = await screenshotRepo.list(filters, page);

    // Galeri icin gecici (presigned) goruntuleme URL'leri
    const withUrls = await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        sessionId: item.sessionId,
        userId: item.userId,
        timestamp: item.timestamp.toISOString(),
        monitorIndex: item.monitorIndex,
        monitorName: item.monitorName,
        blurApplied: item.blurApplied,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        deletedByEmployee: item.deletedByEmployee,
        deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
        deductedSeconds: item.deductedSeconds,
        url: item.deletedAt ? null : await storage.presignGet(item.storageKey),
      })),
    );

    return { items: withUrls, total, limit: page.limit, offset: page.offset };
  });

  app.get('/:id', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const record = await screenshotRepo.findById(id);
    if (!record) throw notFound('Ekran goruntusu bulunamadi');
    if (record.userId !== user.id) await assertCanAccessUser(user, record.userId);
    return {
      screenshot: {
        ...record,
        url: record.deletedAt ? null : await storage.presignGet(record.storageKey),
      },
    };
  });

  /** Goruntuleme icin taze presigned URL (URL'ler kisa omurludur). */
  app.get('/:id/url', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const record = await screenshotRepo.findById(id);
    if (!record) throw notFound('Ekran goruntusu bulunamadi');
    if (record.userId !== user.id) await assertCanAccessUser(user, record.userId);
    if (record.deletedAt) throw notFound('Bu goruntu silinmis');
    return { url: await storage.presignGet(record.storageKey), expiresIn: config.s3.presignTtl };
  });

  /**
   * Gizlilik protokolu: calisan kendi goruntusunu siler.
   * Ayni anda o blogun mesai suresi dusulur ve olay denetim kaydina islenir.
   */
  app.delete('/:id', async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const record = await screenshotRepo.findById(id);
    if (!record) throw notFound('Ekran goruntusu bulunamadi');

    // Yalnizca kaydin sahibi silebilir; admin dahil baskalari silemez.
    if (record.userId !== user.id) {
      throw forbidden('Yalnizca kendi ekran goruntunuzu silebilirsiniz');
    }
    if (record.deletedAt) throw notFound('Bu goruntu zaten silinmis');

    const session = await sessionRepo.findById(record.sessionId);
    // Is kurali: silinen karenin blogu (varsayilan 10 dk) tamamen dusulur.
    // Odenebilir sure 0'in altina inemez (payableSeconds GREATEST(...,0) ile korunur).
    const blockSeconds = config.rules.screenshotBlockSeconds;

    const deleted = await screenshotRepo.softDeleteByEmployee(id, user.id, blockSeconds);
    if (!deleted) throw notFound('Goruntu silinemedi');

    // S3 nesnesi de silinir
    await storage.deleteObject(record.storageKey);
    if (session) await sessionRepo.addDeductedSeconds(session.id, blockSeconds);

    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'screenshot.delete_by_employee',
      entityType: 'screenshot',
      entityId: id,
      metadata: {
        sessionId: record.sessionId,
        timestamp: record.timestamp.toISOString(),
        deductedSeconds: blockSeconds,
        blockRule: config.rules.screenshotBlockSeconds,
      },
      ipAddress: request.ip,
    });

    const updatedSession = session ? await sessionRepo.findById(session.id) : null;
    return {
      ok: true,
      deductedSeconds: blockSeconds,
      session: updatedSession ? sessionService.toDto(updatedSession) : null,
      notice: `${Math.round(blockSeconds / 60)} dakikalik blok mesai suresinden dusuldu.`,
    };
  });
}
