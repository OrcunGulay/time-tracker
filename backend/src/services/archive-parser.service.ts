/**
 * Yüklenen ZIP arşivlerini veya Excel dosyalarını bellek üzerinde açıp
 * koç hakedişlerini hesaplayan ayrıştırıcı servis.
 */
import AdmZip from 'adm-zip';
import * as coachRepo from '../repositories/coach-payroll.repo.js';
import type { CoachMeeting, CoachPayrollRecord, CoachPayrollSummary } from '../types/api.js';
import { resolveCoachPeriod } from './coach-payroll.service.js';
import { parseWorksheetMeetings } from './google-drive.service.js';

export interface ParseArchiveResult {
  summary: CoachPayrollSummary;
  syncedCount: number;
  errorCount: number;
  message: string;
}

/** Dosya adından koç adını tahmin eder */
export function extractCoachNameFromFilename(filename: string): string {
  let name = filename.replace(/\.(xlsx|xls|csv)$/i, '');
  // "İşleyiş Tablosu - Ahmet Yılmaz" -> "Ahmet Yılmaz"
  name = name.replace(/^[iIİı][sşSŞ][lL][eE][yY][iIİı][sşSŞ]?\s*(tablosu)?\s*[-_:]?\s*/iu, '');
  // "Ahmet Yılmaz - İşleyiş Tablosu" -> "Ahmet Yılmaz"
  name = name.replace(/\s*[-_:]\s*[iIİı][sşSŞ][lL][eE][yY][iIİı][sşSŞ]?\s*(tablosu)?$/iu, '');
  return name.trim() || 'Bilinmeyen Koç';
}

/**
 * ZIP arşivi içindeki dosyaları klasör hiyerarşisine göre koçlara gruplar
 * ve her koçun "İşleyiş Tablosu" dosyasını bellekten okur.
 */
export async function parseZipArchive(
  zipBuffer: Buffer,
  monthParam?: string,
): Promise<ParseArchiveResult> {
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();

  const period = resolveCoachPeriod(monthParam);
  const rates = await coachRepo.getCoachRates();
  const rateMap = new Map<string, number>(rates.map((r) => [r.categoryName, r.rate]));

  // Koç klasörlerini tespit et: Map<coachName, Array<AdmZip.IZipEntry>>
  const coachFilesMap = new Map<string, AdmZip.IZipEntry[]>();

  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;

    const entryPath = entry.entryName.replace(/\\/g, '/');

    // macOS gizli dosyaları ve üst dizinlerini atla
    if (
      entryPath.includes('__MACOSX') ||
      entryPath.split('/').some((segment) => segment.startsWith('.') || segment === '.DS_Store')
    ) {
      continue;
    }

    const segments = entryPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let coachName = '';

    // Durum 1: "Koçlar/Ahmet Yılmaz/İşleyiş Tablosu.xlsx"
    const firstLower = (segments[0] ?? '').toLocaleLowerCase('tr-TR');
    if (
      (firstLower === 'koçlar' || firstLower === 'koclar' || firstLower === 'coaches') &&
      segments.length >= 3
    ) {
      coachName = (segments[1] ?? '').trim();
    }
    // Durum 2: "Ahmet Yılmaz/İşleyiş Tablosu.xlsx"
    else if (segments.length >= 2) {
      coachName = (segments[0] ?? '').trim();
    }
    // Durum 3: Kök dizinde "İşleyiş Tablosu - Ahmet Yılmaz.xlsx"
    else {
      const fileName = segments[0] ?? '';
      coachName = extractCoachNameFromFilename(fileName);
    }

    if (!coachName) continue;

    if (!coachFilesMap.has(coachName)) {
      coachFilesMap.set(coachName, []);
    }
    coachFilesMap.get(coachName)!.push(entry);
  }

  if (coachFilesMap.size === 0) {
    throw new Error('Yüklenen ZIP arşivinde koç klasörü veya Excel dosyası bulunamadı.');
  }

  const coachEntries = Array.from(coachFilesMap.entries());

  // Her koçu Promise.allSettled ile dayanıklı işle
  const processPromises = coachEntries.map(async ([coachName, entries]) => {
    try {
      // "İşleyiş Tablosu" dosyasını bul (veya klasördeki ilk .xlsx dosyası)
      let targetEntry = entries.find((e) => {
        const lower = e.name.toLocaleLowerCase('tr-TR');
        return (
          (lower.includes('işleyiş') || lower.includes('isleyis') || lower.includes('isleyi')) &&
          (lower.endsWith('.xlsx') || lower.endsWith('.xls'))
        );
      });

      if (!targetEntry) {
        // Alternatif olarak klasördeki tek veya ilk excel dosyası
        targetEntry = entries.find((e) => {
          const lower = e.name.toLowerCase();
          return lower.endsWith('.xlsx') || lower.endsWith('.xls');
        });
      }

      if (!targetEntry) {
        return {
          month: period.month,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          coachName,
          driveFolderId: null,
          spreadsheetId: null,
          spreadsheetName: null,
          totalMeetings: 0,
          totalAmount: 0,
          categoryBreakdown: {},
          meetings: [] as CoachMeeting[],
          hasError: true,
          errorMessage: 'Klasörde "İşleyiş Tablosu" (.xlsx) dosyası bulunamadı.',
        };
      }

      const fileBuffer = targetEntry.getData();
      const { meetings, categoryBreakdown, totalAmount } = parseWorksheetMeetings(
        fileBuffer,
        period.periodStart,
        period.periodEnd,
        rateMap,
      );

      return {
        month: period.month,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        coachName,
        driveFolderId: null,
        spreadsheetId: null,
        spreadsheetName: targetEntry.name,
        totalMeetings: meetings.length,
        totalAmount,
        categoryBreakdown,
        meetings,
        hasError: false,
        errorMessage: null,
      };
    } catch (err) {
      return {
        month: period.month,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        coachName,
        driveFolderId: null,
        spreadsheetId: null,
        spreadsheetName: null,
        totalMeetings: 0,
        totalAmount: 0,
        categoryBreakdown: {},
        meetings: [] as CoachMeeting[],
        hasError: true,
        errorMessage: err instanceof Error ? err.message : 'Dosya ayrıştırma hatası',
      };
    }
  });

  const settled = await Promise.allSettled(processPromises);
  const recordsToSave = settled.map((res, idx) => {
    if (res.status === 'fulfilled') return res.value;
    const coachName = coachEntries[idx]?.[0] ?? `Koç-${idx + 1}`;
    return {
      month: period.month,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      coachName,
      driveFolderId: null,
      spreadsheetId: null,
      spreadsheetName: null,
      totalMeetings: 0,
      totalAmount: 0,
      categoryBreakdown: {},
      meetings: [] as CoachMeeting[],
      hasError: true,
      errorMessage: res.reason instanceof Error ? res.reason.message : 'Bilinmeyen hata',
    };
  });

  // Veritabanına kaydet
  await coachRepo.saveCoachPayrollBatch(recordsToSave);

  const updatedRecords = await coachRepo.getCoachPayrollRecords(period.month);
  const activeCoaches = updatedRecords.filter((r) => !r.hasError).length;
  const warningCoaches = updatedRecords.filter((r) => r.hasError).length;
  const totalMeetings = updatedRecords.reduce((sum, r) => sum + r.totalMeetings, 0);
  const totalAmount = updatedRecords.reduce((sum, r) => sum + r.totalAmount, 0);

  const summary: CoachPayrollSummary = {
    month: period.month,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodLabel: period.periodLabel,
    totalCoaches: updatedRecords.length,
    activeCoaches,
    warningCoaches,
    totalMeetings,
    totalAmount,
    currency: 'TRY',
    items: updatedRecords,
  };

  return {
    summary,
    syncedCount: updatedRecords.length,
    errorCount: warningCoaches,
    message: `Yüklenen ZIP arşivinden ${updatedRecords.length} koç başarıyla ayrıştırıldı (${activeCoaches} aktif, ${warningCoaches} uyarı).`,
  };
}

/**
 * Tek bir Excel dosyasını doğrudan ayrıştırır.
 */
export async function parseSingleExcelFile(
  filename: string,
  buffer: Buffer,
  monthParam?: string,
): Promise<ParseArchiveResult> {
  const period = resolveCoachPeriod(monthParam);
  const rates = await coachRepo.getCoachRates();
  const rateMap = new Map<string, number>(rates.map((r) => [r.categoryName, r.rate]));

  const coachName = extractCoachNameFromFilename(filename);

  try {
    const { meetings, categoryBreakdown, totalAmount } = parseWorksheetMeetings(
      buffer,
      period.periodStart,
      period.periodEnd,
      rateMap,
    );

    const record = {
      month: period.month,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      coachName,
      driveFolderId: null,
      spreadsheetId: null,
      spreadsheetName: filename,
      totalMeetings: meetings.length,
      totalAmount,
      categoryBreakdown,
      meetings,
      hasError: false,
      errorMessage: null,
    };

    await coachRepo.saveCoachPayrollBatch([record]);
  } catch (err) {
    const record = {
      month: period.month,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      coachName,
      driveFolderId: null,
      spreadsheetId: null,
      spreadsheetName: filename,
      totalMeetings: 0,
      totalAmount: 0,
      categoryBreakdown: {},
      meetings: [] as CoachMeeting[],
      hasError: true,
      errorMessage: err instanceof Error ? err.message : 'Dosya okuma hatası',
    };
    await coachRepo.saveCoachPayrollBatch([record]);
  }

  const updatedRecords = await coachRepo.getCoachPayrollRecords(period.month);
  const activeCoaches = updatedRecords.filter((r) => !r.hasError).length;
  const warningCoaches = updatedRecords.filter((r) => r.hasError).length;
  const totalMeetings = updatedRecords.reduce((sum, r) => sum + r.totalMeetings, 0);
  const totalAmount = updatedRecords.reduce((sum, r) => sum + r.totalAmount, 0);

  const summary: CoachPayrollSummary = {
    month: period.month,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodLabel: period.periodLabel,
    totalCoaches: updatedRecords.length,
    activeCoaches,
    warningCoaches,
    totalMeetings,
    totalAmount,
    currency: 'TRY',
    items: updatedRecords,
  };

  return {
    summary,
    syncedCount: 1,
    errorCount: warningCoaches,
    message: `"${coachName}" koçuna ait tablo başarıyla yüklendi ve hesaplandı.`,
  };
}
