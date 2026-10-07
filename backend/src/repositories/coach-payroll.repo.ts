/**
 * coach_rates ve coach_payroll_records tablolari icin veritabani erisim katmani.
 */
import { pool, query, queryOne } from '../db/pool.js';
import type { CoachMeeting, CoachPayrollRecord, CoachRate } from '../types/api.js';

interface DbCoachRate {
  id: string;
  category_name: string;
  rate: string;
  currency: string;
  description: string | null;
  updated_at: Date;
}

interface DbCoachPayrollRecord {
  id: string;
  month: string;
  period_start: string;
  period_end: string;
  coach_name: string;
  drive_folder_id: string | null;
  spreadsheet_id: string | null;
  spreadsheet_name: string | null;
  total_meetings: number;
  total_amount: string;
  category_breakdown: Record<string, number>;
  meetings: CoachMeeting[];
  has_error: boolean;
  error_message: string | null;
  synced_at: Date;
}

function mapDbRate(row: DbCoachRate): CoachRate {
  return {
    id: row.id,
    categoryName: row.category_name,
    rate: Number.parseFloat(row.rate),
    currency: row.currency,
    description: row.description,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapDbRecord(row: DbCoachPayrollRecord): CoachPayrollRecord {
  return {
    id: row.id,
    month: row.month,
    periodStart: typeof row.period_start === 'string' ? row.period_start.slice(0, 10) : new Date(row.period_start).toISOString().slice(0, 10),
    periodEnd: typeof row.period_end === 'string' ? row.period_end.slice(0, 10) : new Date(row.period_end).toISOString().slice(0, 10),
    coachName: row.coach_name,
    driveFolderId: row.drive_folder_id,
    spreadsheetId: row.spreadsheet_id,
    spreadsheetName: row.spreadsheet_name,
    totalMeetings: row.total_meetings,
    totalAmount: Number.parseFloat(row.total_amount),
    categoryBreakdown: row.category_breakdown ?? {},
    meetings: row.meetings ?? [],
    hasError: row.has_error,
    errorMessage: row.error_message,
    syncedAt: row.synced_at instanceof Date ? row.synced_at.toISOString() : String(row.synced_at),
  };
}

export async function getCoachRates(): Promise<CoachRate[]> {
  const res = await query<DbCoachRate>(
    'SELECT id, category_name, rate, currency, description, updated_at FROM coach_rates ORDER BY category_name ASC',
  );
  return res.rows.map(mapDbRate);
}

export async function upsertCoachRates(
  rates: Array<{ categoryName: string; rate: number; currency?: string; description?: string }>,
): Promise<CoachRate[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rates) {
      await client.query(
        `INSERT INTO coach_rates (category_name, rate, currency, description, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (category_name) DO UPDATE SET
           rate = EXCLUDED.rate,
           currency = COALESCE(EXCLUDED.currency, coach_rates.currency),
           description = COALESCE(EXCLUDED.description, coach_rates.description),
           updated_at = now()`,
        [r.categoryName.trim(), r.rate, r.currency ?? 'TRY', r.description ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getCoachRates();
}

export async function getCoachPayrollRecords(month: string): Promise<CoachPayrollRecord[]> {
  const res = await query<DbCoachPayrollRecord>(
    `SELECT id, month, period_start, period_end, coach_name, drive_folder_id,
            spreadsheet_id, spreadsheet_name, total_meetings, total_amount,
            category_breakdown, meetings, has_error, error_message, synced_at
     FROM coach_payroll_records
     WHERE month = $1
     ORDER BY coach_name ASC`,
    [month],
  );
  return res.rows.map(mapDbRecord);
}

export async function upsertCoachPayrollRecord(record: {
  month: string;
  periodStart: string;
  periodEnd: string;
  coachName: string;
  driveFolderId?: string | null;
  spreadsheetId?: string | null;
  spreadsheetName?: string | null;
  totalMeetings: number;
  totalAmount: number;
  categoryBreakdown: Record<string, number>;
  meetings: CoachMeeting[];
  hasError: boolean;
  errorMessage?: string | null;
}): Promise<CoachPayrollRecord> {
  const row = await queryOne<DbCoachPayrollRecord>(
    `INSERT INTO coach_payroll_records (
       month, period_start, period_end, coach_name, drive_folder_id,
       spreadsheet_id, spreadsheet_name, total_meetings, total_amount,
       category_breakdown, meetings, has_error, error_message, synced_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
     ON CONFLICT (month, coach_name) DO UPDATE SET
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       drive_folder_id = EXCLUDED.drive_folder_id,
       spreadsheet_id = EXCLUDED.spreadsheet_id,
       spreadsheet_name = EXCLUDED.spreadsheet_name,
       total_meetings = EXCLUDED.total_meetings,
       total_amount = EXCLUDED.total_amount,
       category_breakdown = EXCLUDED.category_breakdown,
       meetings = EXCLUDED.meetings,
       has_error = EXCLUDED.has_error,
       error_message = EXCLUDED.error_message,
       synced_at = now(),
       updated_at = now()
     RETURNING id, month, period_start, period_end, coach_name, drive_folder_id,
               spreadsheet_id, spreadsheet_name, total_meetings, total_amount,
               category_breakdown, meetings, has_error, error_message, synced_at`,
    [
      record.month,
      record.periodStart,
      record.periodEnd,
      record.coachName,
      record.driveFolderId ?? null,
      record.spreadsheetId ?? null,
      record.spreadsheetName ?? null,
      record.totalMeetings,
      record.totalAmount,
      JSON.stringify(record.categoryBreakdown),
      JSON.stringify(record.meetings),
      record.hasError,
      record.errorMessage ?? null,
    ],
  );

  if (!row) throw new Error('Koç hakediş kaydı oluşturulamadı');
  return mapDbRecord(row);
}

export async function saveCoachPayrollBatch(
  records: Array<{
    month: string;
    periodStart: string;
    periodEnd: string;
    coachName: string;
    driveFolderId?: string | null;
    spreadsheetId?: string | null;
    spreadsheetName?: string | null;
    totalMeetings: number;
    totalAmount: number;
    categoryBreakdown: Record<string, number>;
    meetings: CoachMeeting[];
    hasError: boolean;
    errorMessage?: string | null;
  }>,
): Promise<CoachPayrollRecord[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      await client.query(
        `INSERT INTO coach_payroll_records (
           month, period_start, period_end, coach_name, drive_folder_id,
           spreadsheet_id, spreadsheet_name, total_meetings, total_amount,
           category_breakdown, meetings, has_error, error_message, synced_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
         ON CONFLICT (month, coach_name) DO UPDATE SET
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           drive_folder_id = EXCLUDED.drive_folder_id,
           spreadsheet_id = EXCLUDED.spreadsheet_id,
           spreadsheet_name = EXCLUDED.spreadsheet_name,
           total_meetings = EXCLUDED.total_meetings,
           total_amount = EXCLUDED.total_amount,
           category_breakdown = EXCLUDED.category_breakdown,
           meetings = EXCLUDED.meetings,
           has_error = EXCLUDED.has_error,
           error_message = EXCLUDED.error_message,
           synced_at = now(),
           updated_at = now()`,
        [
          r.month,
          r.periodStart,
          r.periodEnd,
          r.coachName,
          r.driveFolderId ?? null,
          r.spreadsheetId ?? null,
          r.spreadsheetName ?? null,
          r.totalMeetings,
          r.totalAmount,
          JSON.stringify(r.categoryBreakdown),
          JSON.stringify(r.meetings),
          r.hasError,
          r.errorMessage ?? null,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const first = records[0];
  if (!first) return [];
  return getCoachPayrollRecords(first.month);
}
