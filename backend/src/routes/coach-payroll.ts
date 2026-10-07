/**
 * /api/v1/coach-payroll ve /api/v1/coach-rates rotaları.
 * Google Drive entegrasyonu, koç hakediş hesaplamaları ve ücret baremleri yönetimi.
 */
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import * as archiveParserService from '../services/archive-parser.service.js';
import * as coachPayrollService from '../services/coach-payroll.service.js';

export default async function coachPayrollRoutes(app: FastifyInstance): Promise<void> {
  const staffOnly = app.requireRole('admin', 'manager');

  /**
   * POST /coach-payroll/upload-archive
   * Doğrudan ZIP veya Excel dosyası yükleyerek yerel hakediş analizi yapar.
   */
  app.post('/coach-payroll/upload-archive', { preHandler: staffOnly }, async (request) => {
    const data = await request.file();
    if (!data) {
      throw badRequest('Lütfen bir ZIP arşivi veya Excel dosyası yükleyin.');
    }

    const filename = data.filename || 'archive.zip';
    const buffer = await data.toBuffer();

    const fields = data.fields as Record<string, { value?: string } | undefined>;
    const q = request.query as Record<string, string | undefined>;
    const month = fields?.month?.value || q.month;

    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw badRequest('month parametresi YYYY-MM formatında olmalıdır');
    }

    const isZip = filename.toLowerCase().endsWith('.zip') || data.mimetype.includes('zip');
    let result;
    if (isZip) {
      result = await archiveParserService.parseZipArchive(buffer, month);
    } else if (filename.toLowerCase().endsWith('.xlsx') || filename.toLowerCase().endsWith('.xls')) {
      result = await archiveParserService.parseSingleExcelFile(filename, buffer, month);
    } else {
      throw badRequest('Desteklenmeyen dosya formatı. Yalnızca .zip veya .xlsx yükleyebilirsiniz.');
    }

    return {
      ok: true,
      message: result.message,
      syncedCount: result.syncedCount,
      errorCount: result.errorCount,
      data: result.summary,
    };
  });

  /**
   * GET /coach-payroll?month=YYYY-MM
   * İlgili dönem için hesaplanmış koç ödeme listesini getirir.
   */
  app.get('/coach-payroll', { preHandler: staffOnly }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const month = q.month;
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw badRequest('month parametresi YYYY-MM formatında olmalıdır (örn: 2026-03)');
    }

    return coachPayrollService.getCoachPayrollSummary(month);
  });

  /**
   * POST /coach-payroll/sync
   * Google Drive'ı anlık olarak tarayıp verileri yenileyen tetikleyici uç nokta.
   */
  app.post('/coach-payroll/sync', { preHandler: staffOnly }, async (request) => {
    const body = (request.body ?? {}) as { month?: string };
    const q = request.query as Record<string, string | undefined>;
    const month = body.month ?? q.month;

    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw badRequest('month parametresi YYYY-MM formatında olmalıdır');
    }

    const result = await coachPayrollService.syncCoachPayrollFromDrive(month);
    return {
      ok: true,
      message: result.message,
      syncedCount: result.syncedCount,
      errorCount: result.errorCount,
      data: result.summary,
    };
  });

  /**
   * GET /coach-rates
   * Kategori bazlı koçluk ücret baremlerini getirir.
   */
  app.get('/coach-rates', { preHandler: staffOnly }, async () => {
    const rates = await coachPayrollService.getRates();
    return { rates };
  });

  /**
   * PUT /coach-rates
   * Kategori bazlı koçluk ücret baremlerini günceller.
   */
  app.put('/coach-rates', { preHandler: staffOnly }, async (request) => {
    const body = request.body as {
      rates?: Array<{
        categoryName: string;
        rate: number;
        currency?: string;
        description?: string;
      }>;
      month?: string;
    };

    if (!body || !Array.isArray(body.rates) || body.rates.length === 0) {
      throw badRequest('rates dizisi zorunludur ve en az bir kategori içermelidir.');
    }

    for (const r of body.rates) {
      if (!r.categoryName || typeof r.categoryName !== 'string') {
        throw badRequest('Her barem için categoryName geçerli bir metin olmalıdır.');
      }
      if (typeof r.rate !== 'number' || r.rate < 0) {
        throw badRequest(`'${r.categoryName}' için geçerli bir pozitif sayı girilmelidir.`);
      }
    }

    const result = await coachPayrollService.updateRates(body.rates, body.month);
    return {
      ok: true,
      rates: result.rates,
      recalculated: result.recalculated,
    };
  });
}
