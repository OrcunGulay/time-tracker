/** /api/payroll - personel maliyet dokumu, CSV ve PDF fatura ciktilari. */
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { resolveReportScope } from '../lib/scope.js';
import { toZonedDateString } from '../lib/time.js';
import * as auditRepo from '../repositories/misc.repo.js';
import * as payrollService from '../services/payroll.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Donem parametreleri verilmezse icinde bulunulan ayin 1'i - bugun. */
function resolvePeriod(q: Record<string, string | undefined>, timezone: string) {
  const today = toZonedDateString(new Date(), timezone);
  const defaultStart = `${today.slice(0, 7)}-01`;
  const periodStart = q.periodStart ?? defaultStart;
  const periodEnd = q.periodEnd ?? today;
  if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
    throw badRequest('periodStart/periodEnd formati YYYY-MM-DD olmali');
  }
  if (periodEnd < periodStart) throw badRequest('periodEnd, periodStart tan once olamaz');
  return { periodStart, periodEnd };
}

export default async function payrollRoutes(app: FastifyInstance): Promise<void> {
  // Yonetsel uc noktalar: admin veya manager
  const staffOnly = app.requireRole('admin', 'manager');

  /** Calisanin kendi bordro ozeti. */
  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const period = resolvePeriod(q, user.timezone);
    const lines = await payrollService.buildPayrollDetail({ ...period, userIds: [user.id] });
    return {
      ...period,
      items: lines,
      totalAmount: lines.reduce((sum, l) => sum + l.amount, 0),
      currency: lines[0]?.currency ?? user.currency,
    };
  });

  app.get('/summary', { preHandler: staffOnly }, async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const period = resolvePeriod(q, user.timezone);
    const { userIds } = await resolveReportScope(user, q.userId);
    const items = await payrollService.buildPayrollDetail({ ...period, userIds });

    return {
      ...period,
      totalAmount: items.reduce((sum, l) => sum + l.amount, 0),
      totalSeconds: items.reduce((sum, l) => sum + l.payableSeconds, 0),
      currency: items[0]?.currency ?? 'TRY',
      items,
    };
  });

  /** format=csv|pdf */
  app.get('/export', { preHandler: staffOnly }, async (request, reply) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const period = resolvePeriod(q, user.timezone);
    const { userIds } = await resolveReportScope(user, q.userId);
    const rows = await payrollService.buildPayrollDetail({ ...period, userIds });
    const stamp = `${period.periodStart}_${period.periodEnd}`;

    if (q.format === 'pdf') {
      const pdf = await payrollService.payrollToPdf(rows, {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        generatedAt: new Date(),
        generatedBy: user.name,
        title: q.title ?? 'Bordro / Fatura Raporu',
      });
      await auditRepo.insertAudit({
        actorId: user.id,
        actorRole: user.role,
        action: 'payroll.export.pdf',
        entityType: 'payroll',
        entityId: stamp,
        metadata: { userCount: rows.length },
        ipAddress: request.ip,
      });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="bordro_${stamp}.pdf"`)
        .send(pdf);
    }

    if (q.format !== 'csv') throw badRequest("format 'csv' veya 'pdf' olmali");

    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'payroll.export.csv',
      entityType: 'payroll',
      entityId: stamp,
      metadata: { userCount: rows.length },
      ipAddress: request.ip,
    });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="bordro_${stamp}.csv"`)
      .send(payrollService.payrollToCsv(rows));
  });

  /** Donemi dondurur (issued): tutarlar sabitlenir. */
  app.post('/issue', { preHandler: staffOnly }, async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const body = (request.body ?? {}) as {
      periodStart?: string;
      periodEnd?: string;
      userId?: string;
    };
    const period = resolvePeriod({ ...q, ...body }, user.timezone);
    const { userIds } = await resolveReportScope(user, body.userId);
    const rows = await payrollService.buildPayrollDetail({ ...period, userIds });
    const issued = await payrollService.issuePayrollRuns(rows, user.id);
    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'payroll.issue',
      entityType: 'payroll',
      entityId: `${period.periodStart}_${period.periodEnd}`,
      metadata: { issued },
      ipAddress: request.ip,
    });
    return { ok: true, issued, ...period };
  });

  app.get('/runs', { preHandler: staffOnly }, async (request) => {
    const user = currentUser(request);
    const q = request.query as Record<string, string | undefined>;
    const { userIds } = await resolveReportScope(user, q.userId);
    return { items: await payrollService.listPayrollRuns({ userIds, from: q.from, to: q.to }) };
  });

  app.post('/runs/:id/pay', { preHandler: staffOnly }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const ok = await payrollService.markRunPaid(id);
    if (!ok) throw notFound('Bordro kaydi bulunamadi');
    await auditRepo.insertAudit({
      actorId: user.id,
      actorRole: user.role,
      action: 'payroll.mark_paid',
      entityType: 'payroll_run',
      entityId: id,
      ipAddress: request.ip,
    });
    return { ok: true };
  });
}
