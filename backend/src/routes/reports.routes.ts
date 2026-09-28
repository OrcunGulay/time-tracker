/** /api/reports - canli durum, gunluk ozet, zaman cizelgesi, kullanim dagilimi. */
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { resolveReportScope } from '../lib/scope.js';
import { toZonedDateString, zonedDayRange } from '../lib/time.js';
import * as reportService from '../services/report.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /** Canli durum sayfasi: kim cevrimici, hangi projede, en son ne zaman aktif. */
  app.get('/live', async (request) => {
    const user = currentUser(request);
    const { userIds } = await resolveReportScope(user, null);
    return { items: await reportService.liveStatus(userIds) };
  });

  /** GET /api/reports/daily?date=YYYY-MM-DD&userId=&projectId= */
  app.get('/daily', async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const date = q.date ?? toZonedDateString(new Date(), user.timezone);
    if (!DATE_RE.test(date)) throw badRequest('date formati YYYY-MM-DD olmali');

    const { userIds } = await resolveReportScope(user, q.userId);
    const result = await reportService.dailyReport({
      date,
      userIds,
      projectId: q.projectId,
      timezone: user.timezone,
    });
    return result;
  });

  /** Zaman cizelgesi: gunun saat saat dokumu (yesil/sari/kirmizi dilimler). */
  app.get('/timeline', async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const date = q.date ?? toZonedDateString(new Date(), user.timezone);
    if (!DATE_RE.test(date)) throw badRequest('date formati YYYY-MM-DD olmali');

    const { userIds, singleUserId } = await resolveReportScope(user, q.userId);
    const targetUserId = singleUserId ?? (userIds === 'all' ? user.id : userIds[0]);
    if (!targetUserId) throw badRequest('userId gerekli');

    const slotMinutes = q.slotMinutes ? Number(q.slotMinutes) : 5;
    return reportService.timelineForUser({
      userId: targetUserId,
      date,
      timezone: user.timezone,
      slotMinutes: Number.isFinite(slotMinutes) ? Math.min(60, Math.max(1, slotMinutes)) : 5,
    });
  });

  /** Uygulama / domain kullanim dagilimi (pasta-bar grafik). */
  app.get('/usage', async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const date = q.date ?? toZonedDateString(new Date(), user.timezone);
    if (!DATE_RE.test(date)) throw badRequest('date formati YYYY-MM-DD olmali');

    const { start, end } = zonedDayRange(date, user.timezone);
    const { userIds } = await resolveReportScope(user, q.userId);
    const groupBy = q.groupBy === 'domain' ? 'domain' : 'app';

    return {
      date,
      groupBy,
      items: await reportService.usageReport({ userIds, from: start, to: end, groupBy }),
    };
  });

  /** Uretkenlik skoru raporu (donem bazli, kullanici kirilimli). */
  app.get('/productivity', async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const today = toZonedDateString(new Date(), user.timezone);
    const fromDate = q.from ?? today;
    const toDate = q.to ?? today;
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
      throw badRequest('from/to formati YYYY-MM-DD olmali');
    }
    const { start } = zonedDayRange(fromDate, user.timezone);
    const { end } = zonedDayRange(toDate, user.timezone);
    const { userIds } = await resolveReportScope(user, q.userId);
    return reportService.productivityReport({ userIds, from: start, to: end });
  });
}
