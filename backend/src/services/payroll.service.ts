/**
 * Bordro & maliyet yonetimi.
 *
 * Odenecek sure = toplam - bosluk - silinen ekran goruntusu bloklari.
 * `sessions.status = 'approved'` olan kayitlar "onaylanmis" saat olarak ayrilir.
 */
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { hoursFromSeconds, round2, zonedDayRange } from '../lib/time.js';
import { computeProductivityScore } from './productivity.service.js';
import type { PayrollLine } from '../types/api.js';

export interface PayrollQuery {
  periodStart: string; // YYYY-MM-DD (dahil)
  periodEnd: string;   // YYYY-MM-DD (dahil)
  userIds: string[] | 'all';
  /** Donem tarihleri bu saat diliminde yorumlanir (varsayilan: sirket dilimi). */
  timezone?: string;
}

/**
 * Bordro donemini [baslangic, bitis) UTC araligina cevirir.
 * Tarihleri UTC'ye cevirip `timestamptz` ile karsilastirmak, veritabani sunucu
 * saat dilimine bagimliligi ortadan kaldirir (gece yarisi kaymalarini onler).
 */
function periodBounds(input: { periodStart: string; periodEnd: string; timezone?: string }): {
  from: Date;
  to: Date;
} {
  const zone = input.timezone ?? config.timezone;
  const from = zonedDayRange(input.periodStart, zone).start;
  const to = zonedDayRange(input.periodEnd, zone).end;
  return { from, to };
}

interface PayrollRawRow {
  userId: string;
  userName: string;
  email: string;
  hourlyRate: number;
  currency: string;
  payableSeconds: number;
  approvedSeconds: number;
  unapprovedSeconds: number;
  sessionCount: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  idleSeconds: number;
  deductedSeconds: number;
}

/**
 * Donem icindeki oturumlari kullanici bazinda toplar.
 * Bos durumda bos dizi doner.
 */
export async function buildPayrollLines(input: PayrollQuery): Promise<PayrollLine[]> {
  if (input.userIds !== 'all' && input.userIds.length === 0) return [];
  const { from, to } = periodBounds(input);
  const filter = input.userIds === 'all' ? '' : 'AND u.id = ANY($3::uuid[])';
  const values: unknown[] = [from, to];
  if (input.userIds !== 'all') values.push(input.userIds);

  const { rows } = await query<PayrollRawRow>(
    `SELECT
       u.id                       AS "userId",
       u.name                     AS "userName",
       u.email                    AS "email",
       u.hourly_rate::float8      AS "hourlyRate",
       u.currency                 AS "currency",
       -- Odenebilir = toplam - bosluk - silinen blok + "calisilmis say" kredisi
       coalesce(sum(GREATEST(s.total_duration - s.idle_duration - s.deducted_seconds + s.credited_seconds, 0)), 0)::int AS "payableSeconds",
       coalesce(sum(CASE WHEN s.status = 'approved'
         THEN GREATEST(s.total_duration - s.idle_duration - s.deducted_seconds + s.credited_seconds, 0) ELSE 0 END), 0)::int AS "approvedSeconds",
       coalesce(sum(CASE WHEN s.status = 'stopped'
         THEN GREATEST(s.total_duration - s.idle_duration - s.deducted_seconds + s.credited_seconds, 0) ELSE 0 END), 0)::int AS "unapprovedSeconds",
       count(s.id)::int           AS "sessionCount",
       coalesce(sum(s.productive_seconds), 0)::int   AS "productiveSeconds",
       coalesce(sum(s.unproductive_seconds), 0)::int AS "unproductiveSeconds",
       coalesce(sum(s.neutral_seconds), 0)::int      AS "neutralSeconds",
       coalesce(sum(s.idle_duration), 0)::int        AS "idleSeconds",
       coalesce(sum(s.deducted_seconds), 0)::int     AS "deductedSeconds"
     FROM users u
     JOIN sessions s ON s.user_id = u.id
     WHERE u.is_active = true
       AND s.status <> 'active'
       AND s.start_time >= $1
       AND s.start_time < $2
       ${filter}
     GROUP BY u.id, u.name, u.email, u.hourly_rate, u.currency
     ORDER BY u.name ASC`,
    values,
  );

  return rows.map((r) => {
    const payableHours = hoursFromSeconds(r.payableSeconds);
    return {
      userId: r.userId,
      userName: r.userName,
      email: r.email,
      currency: r.currency,
      hourlyRate: r.hourlyRate,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payableSeconds: r.payableSeconds,
      payableHours,
      amount: round2(payableHours * r.hourlyRate),
      sessionCount: r.sessionCount,
      approvedSeconds: r.approvedSeconds,
      unapprovedSeconds: r.unapprovedSeconds,
    } satisfies PayrollLine;
  });
}

export interface PayrollDetailRow extends PayrollLine {
  productivityScore: number;
  idleSeconds: number;
  deductedSeconds: number;
}

/** Detayli (verimlilik dahil) bordro dokumu. */
export async function buildPayrollDetail(input: PayrollQuery): Promise<PayrollDetailRow[]> {
  const lines = await buildPayrollLines(input);
  if (lines.length === 0) return [];
  const { from, to } = periodBounds(input);
  const values: unknown[] = [from, to];
  const filter = input.userIds === 'all' ? '' : 'AND s.user_id = ANY($3::uuid[])';
  if (input.userIds !== 'all') values.push(input.userIds);

  const { rows } = await query<{
    userId: string;
    productiveSeconds: number;
    unproductiveSeconds: number;
    neutralSeconds: number;
    idleSeconds: number;
    deductedSeconds: number;
  }>(
    `SELECT s.user_id AS "userId",
            coalesce(sum(s.productive_seconds), 0)::int AS "productiveSeconds",
            coalesce(sum(s.unproductive_seconds), 0)::int AS "unproductiveSeconds",
            coalesce(sum(s.neutral_seconds), 0)::int AS "neutralSeconds",
            coalesce(sum(s.idle_duration), 0)::int AS "idleSeconds",
            coalesce(sum(s.deducted_seconds), 0)::int AS "deductedSeconds"
     FROM sessions s
     WHERE s.status <> 'active'
       AND s.start_time >= $1 AND s.start_time < $2
       ${filter}
     GROUP BY s.user_id`,
    values,
  );

  const stats = new Map(rows.map((r) => [r.userId, r]));
  return lines.map((line) => {
    const s = stats.get(line.userId);
    return {
      ...line,
      productivityScore: computeProductivityScore(
        {
          productiveSeconds: s?.productiveSeconds ?? 0,
          unproductiveSeconds: s?.unproductiveSeconds ?? 0,
          neutralSeconds: s?.neutralSeconds ?? 0,
        },
        0,
      ),
      idleSeconds: s?.idleSeconds ?? 0,
      deductedSeconds: s?.deductedSeconds ?? 0,
    };
  });
}

/** CSV (Excel uyumlu, noktali virgul ayirici). */
export function payrollToCsv(rows: readonly PayrollDetailRow[]): string {
  const header = [
    'Personel', 'E-posta', 'Donem Baslangic', 'Donem Bitis',
    'Odenebilir Saat', 'Saatlik Ucret', 'Para Birimi', 'Tutar',
    'Onaylanan Saat', 'Onaysiz Saat', 'Oturum', 'Uretkenlik %', 'Bosluk (dk)', 'Silinen Blok (dk)',
  ];
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.userName, r.email, r.periodStart, r.periodEnd,
        r.payableHours.toFixed(2), r.hourlyRate.toFixed(2), r.currency, r.amount.toFixed(2),
        hoursFromSeconds(r.approvedSeconds).toFixed(2),
        hoursFromSeconds(r.unapprovedSeconds).toFixed(2),
        r.sessionCount, r.productivityScore.toFixed(1),
        Math.round(r.idleSeconds / 60), Math.round(r.deductedSeconds / 60),
      ].map(escape).join(';'),
    );
  }
  // BOM: Excel'in UTF-8'i dogru okumasi icin
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export interface PdfMeta {
  periodStart: string;
  periodEnd: string;
  generatedAt: Date;
  generatedBy: string;
  currency?: string;
  title?: string;
}

/** Bordro PDF'i (pdfkit). Streaming yerine buffer uretir; boyutlar kucuktur. */
export async function payrollToPdf(
  rows: readonly PayrollDetailRow[],
  meta: PdfMeta,
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const currency = meta.currency ?? rows[0]?.currency ?? 'TRY';
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalSeconds = rows.reduce((sum, r) => sum + r.payableSeconds, 0);

  doc.fontSize(18).text(meta.title ?? 'Bordro / Fatura Raporu', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#444')
    .text(`Donem: ${meta.periodStart} - ${meta.periodEnd}`)
    .text(`Olusturma: ${meta.generatedAt.toISOString()} | Olusturan: ${meta.generatedBy}`)
    .text(`Personel sayisi: ${rows.length} | Toplam odenebilir saat: ${hoursFromSeconds(totalSeconds).toFixed(2)} | Toplam tutar: ${total.toFixed(2)} ${currency}`);
  doc.moveDown(0.8);

  const columns: Array<{ title: string; width: number; align?: 'left' | 'right' }> = [
    { title: 'Personel', width: 150 },
    { title: 'Saat', width: 55, align: 'right' },
    { title: 'Saatlik', width: 65, align: 'right' },
    { title: 'Tutar', width: 75, align: 'right' },
    { title: 'Onayli', width: 60, align: 'right' },
    { title: 'Onaysiz', width: 60, align: 'right' },
    { title: 'Uretkenlik', width: 65, align: 'right' },
    { title: 'Bosluk', width: 60, align: 'right' },
    { title: 'Oturum', width: 45, align: 'right' },
  ];

  const tableLeft = doc.page.margins.left;
  const rowHeight = 18;
  const drawHeader = (y: number): number => {
    doc.fontSize(9).fillColor('#000');
    let x = tableLeft;
    for (const c of columns) {
      doc.text(c.title, x, y, { width: c.width, align: c.align ?? 'left' });
      x += c.width;
    }
    doc.moveTo(tableLeft, y + rowHeight - 4).lineTo(x, y + rowHeight - 4).strokeColor('#ccc').stroke();
    return y + rowHeight;
  };

  let y = drawHeader(doc.y);
  for (const r of rows) {
    if (y > doc.page.height - doc.page.margins.bottom - rowHeight) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    let x = tableLeft;
    const cells: string[] = [
      r.userName,
      hoursFromSeconds(r.payableSeconds).toFixed(2),
      r.hourlyRate.toFixed(2),
      r.amount.toFixed(2),
      hoursFromSeconds(r.approvedSeconds).toFixed(2),
      hoursFromSeconds(r.unapprovedSeconds).toFixed(2),
      `${r.productivityScore.toFixed(1)}%`,
      `${Math.round(r.idleSeconds / 60)} dk`,
      String(r.sessionCount),
    ];
    cells.forEach((cell, i) => {
      const col = columns[i];
      if (!col) return;
      doc.fontSize(9).fillColor('#111')
        .text(cell, x, y, { width: col.width, align: col.align ?? 'left', lineBreak: false });
      x += col.width;
    });
    y += rowHeight;
  }

  doc.moveDown(1.5);
  doc.fontSize(11).fillColor('#000')
    .text(`TOPLAM: ${total.toFixed(2)} ${currency}`, tableLeft, y + 10, { align: 'left' });
  doc.fontSize(8).fillColor('#666')
    .text('Bu rapor onaylanan ve onay bekleyen oturumlarin odenebilir surelerine gore uretilmistir.', tableLeft, y + 34);

  doc.end();
  return done;
}

// ------------------------------------------------------------ payroll_runs

export async function findRun(periodStart: string, periodEnd: string, userId: string) {
  return queryOne(
    `SELECT id FROM payroll_runs WHERE user_id = $1 AND period_start = $2::date AND period_end = $3::date`,
    [userId, periodStart, periodEnd],
  );
}

/** Bordroyu donduur (issued): tutarlar o anki verilerle sabitlenir. */
export async function issuePayrollRuns(
  rows: readonly PayrollDetailRow[],
  actorId: string,
): Promise<number> {
  let issued = 0;
  for (const row of rows) {
    await query(
      `INSERT INTO payroll_runs (
         user_id, period_start, period_end, total_seconds, billable_seconds,
         hourly_rate, currency, amount, status, issued_at, meta
       ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, 'issued', now(), $9::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        row.userId,
        row.periodStart,
        row.periodEnd,
        row.payableSeconds + row.idleSeconds + row.deductedSeconds,
        row.payableSeconds,
        row.hourlyRate,
        row.currency,
        row.amount,
        JSON.stringify({ issuedBy: actorId, productivityScore: row.productivityScore }),
      ],
    );
    issued += 1;
  }
  return issued;
}

export async function listPayrollRuns(input: {
  userIds: string[] | 'all';
  from?: string;
  to?: string;
}): Promise<Array<Record<string, unknown>>> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.userIds !== 'all') {
    if (input.userIds.length === 0) return [];
    values.push(input.userIds);
    where.push(`pr.user_id = ANY($${values.length}::uuid[])`);
  }
  if (input.from) { values.push(input.from); where.push(`pr.period_end >= $${values.length}::date`); }
  if (input.to) { values.push(input.to); where.push(`pr.period_start <= $${values.length}::date`); }

  const { rows } = await query<Record<string, unknown>>(
    `SELECT pr.id, pr.user_id AS "userId", u.name AS "userName", pr.period_start AS "periodStart",
            pr.period_end AS "periodEnd", pr.billable_seconds AS "billableSeconds",
            pr.hourly_rate::float8 AS "hourlyRate", pr.currency, pr.amount::float8 AS amount,
            pr.status, pr.issued_at AS "issuedAt", pr.paid_at AS "paidAt"
     FROM payroll_runs pr
     JOIN users u ON u.id = pr.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY pr.period_start DESC, u.name ASC
     LIMIT 1000`,
    values,
  );
  return rows;
}

export async function markRunPaid(id: string): Promise<boolean> {
  const res = await query(`UPDATE payroll_runs SET status = 'paid', paid_at = now() WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
