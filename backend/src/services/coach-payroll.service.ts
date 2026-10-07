/**
 * Koç Hakediş / Ödeme Yönetimi iş mantığı servisi.
 */
import { config } from '../config.js';
import * as coachRepo from '../repositories/coach-payroll.repo.js';
import type { CoachMeeting, CoachPayrollRecord, CoachPayrollSummary, CoachRate } from '../types/api.js';
import {
  downloadFileBuffer,
  findWorksheetFile,
  getDriveClient,
  isGoogleDriveConfigured,
  listCoachFolders,
  parseWorksheetMeetings,
} from './google-drive.service.js';

const TURKISH_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

export interface ResolvedPeriod {
  month: string; // YYYY-MM
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  periodLabel: string;
}

/**
 * Dönem parametrelerini çözümler.
 * Kural: İki ayın 15'i arası: [Geçen Ay 15, 00:00:00] ile [Bu Ay 15, 23:59:59].
 * month='2026-03' ise: 2026-02-15 ile 2026-03-15.
 */
export function resolveCoachPeriod(monthParam?: string): ResolvedPeriod {
  let year: number;
  let month: number; // 1 - 12

  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const parts = monthParam.split('-').map(Number);
    year = parts[0] ?? 2026;
    month = parts[1] ?? 3;
  } else {
    // Bugünün tarihine göre varsayılan dönem
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1; // 1-12
    // Eğer ayın 15'inden önceyse bu ayı baz al, sonraysa gelecek ayı hedefle
    if (now.getDate() < 15 && month > 1) {
      // 1-14 arası, bu ayın 15'i bitiş kabul edilir
    }
  }

  // Bu Ay 15
  const endMonthStr = String(month).padStart(2, '0');
  const periodEnd = `${year}-${endMonthStr}-15`;

  // Geçen Ay 15
  let prevYear = year;
  let prevMonth = month - 1;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear -= 1;
  }
  const startMonthStr = String(prevMonth).padStart(2, '0');
  const periodStart = `${prevYear}-${startMonthStr}-15`;

  const monthKey = `${year}-${endMonthStr}`;
  const startMonthName = TURKISH_MONTHS[prevMonth - 1];
  const endMonthName = TURKISH_MONTHS[month - 1];
  const periodLabel = `15 ${startMonthName} ${prevYear} – 15 ${endMonthName} ${year}`;

  return {
    month: monthKey,
    periodStart,
    periodEnd,
    periodLabel,
  };
}

/**
 * Verilen ay için koç hakediş özetini veritabanından getirir.
 */
export async function getCoachPayrollSummary(monthParam?: string): Promise<CoachPayrollSummary> {
  const period = resolveCoachPeriod(monthParam);
  let records = await coachRepo.getCoachPayrollRecords(period.month);

  // Veritabanında henüz bu ay için kayıt yoksa ve varsayılan ay 2026-03 ise
  if (records.length === 0 && period.month === '2026-03') {
    // Eğer başka aylarda kayıt varsa veya demo verisi oluşturulacaksa
    // 004 migration zaten 2026-03 için seed ekledi, ama boş dönerse kontrol
    records = await coachRepo.getCoachPayrollRecords(period.month);
  }

  const totalCoaches = records.length;
  const activeCoaches = records.filter((r) => !r.hasError).length;
  const warningCoaches = records.filter((r) => r.hasError).length;
  const totalMeetings = records.reduce((sum, r) => sum + r.totalMeetings, 0);
  const totalAmount = records.reduce((sum, r) => sum + r.totalAmount, 0);

  return {
    month: period.month,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodLabel: period.periodLabel,
    totalCoaches,
    activeCoaches,
    warningCoaches,
    totalMeetings,
    totalAmount,
    currency: 'TRY',
    items: records,
  };
}

/**
 * Google Drive'ı anlık olarak tarar ve koç hakedişlerini hesaplayıp kaydeder.
 * Dayanıklılık kuralı: Her koç Promise.allSettled ile taranır, biri patlarsa diğerleri etkilenmez.
 */
export async function syncCoachPayrollFromDrive(monthParam?: string): Promise<{
  summary: CoachPayrollSummary;
  syncedCount: number;
  errorCount: number;
  message: string;
}> {
  const period = resolveCoachPeriod(monthParam);
  const rates = await coachRepo.getCoachRates();
  const rateMap = new Map<string, number>(rates.map((r) => [r.categoryName, r.rate]));

  // Google Drive yapılandırmasını kontrol et
  if (!isGoogleDriveConfigured()) {
    // Yapılandırma eksikse mevcut verileri getir ve uyarı mesajı ile dön
    const existing = await getCoachPayrollSummary(period.month);
    return {
      summary: existing,
      syncedCount: existing.items.length,
      errorCount: existing.warningCoaches,
      message:
        'Google Drive Service Account yapılandırması (.env) eksik olduğu için canlı Drive senkronizasyonu gerçekleştirilemedi. Mevcut kayıtlar gösteriliyor.',
    };
  }

  const drive = getDriveClient();
  if (!drive) {
    throw new Error('Google Drive API istemcisi başlatılamadı.');
  }

  const coachesFolderId = config.google.coachesFolderId;
  const coachFolders = await listCoachFolders(drive, coachesFolderId);

  if (coachFolders.length === 0) {
    return {
      summary: await getCoachPayrollSummary(period.month),
      syncedCount: 0,
      errorCount: 0,
      message: '"Koçlar" ana klasöründe alt klasör bulunamadı.',
    };
  }

  // Her koç klasörünü Promise.allSettled ile paralel ve dayanıklı tara
  const scanPromises = coachFolders.map(async (folder) => {
    const coachName = folder.name;
    const folderId = folder.id;

    try {
      // 1. "İşleyiş Tablosu" dosyasını bul
      const worksheetFile = await findWorksheetFile(drive, folderId);
      if (!worksheetFile) {
        return {
          month: period.month,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          coachName,
          driveFolderId: folderId,
          spreadsheetId: null,
          spreadsheetName: null,
          totalMeetings: 0,
          totalAmount: 0,
          categoryBreakdown: {},
          meetings: [] as CoachMeeting[],
          hasError: true,
          errorMessage: 'Klasörde "İşleyiş Tablosu" dosyası tespit edilemedi.',
        };
      }

      // 2. Dosya içeriğini belleğe indir
      const buffer = await downloadFileBuffer(drive, worksheetFile);

      // 3. Zoom Toplantıları sekmesini ayrıştır ve hakedişi hesapla
      const { meetings, categoryBreakdown, totalAmount } = parseWorksheetMeetings(
        buffer,
        period.periodStart,
        period.periodEnd,
        rateMap,
      );

      return {
        month: period.month,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        coachName,
        driveFolderId: folderId,
        spreadsheetId: worksheetFile.id,
        spreadsheetName: worksheetFile.name,
        totalMeetings: meetings.length,
        totalAmount,
        categoryBreakdown,
        meetings,
        hasError: false,
        errorMessage: null,
      };
    } catch (err) {
      // Herhangi bir koçun dosyasında hata olursa tüm akış patlamaz
      return {
        month: period.month,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        coachName,
        driveFolderId: folderId,
        spreadsheetId: null,
        spreadsheetName: null,
        totalMeetings: 0,
        totalAmount: 0,
        categoryBreakdown: {},
        meetings: [] as CoachMeeting[],
        hasError: true,
        errorMessage: err instanceof Error ? err.message : 'Bilinmeyen dosya okuma hatası',
      };
    }
  });

  const settledResults = await Promise.allSettled(scanPromises);
  const recordsToSave = settledResults.map((res, index) => {
    if (res.status === 'fulfilled') {
      return res.value;
    }
    // Rejected durumu
    const folder = coachFolders[index];
    return {
      month: period.month,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      coachName: folder?.name ?? `Koç-${index + 1}`,
      driveFolderId: folder?.id ?? null,
      spreadsheetId: null,
      spreadsheetName: null,
      totalMeetings: 0,
      totalAmount: 0,
      categoryBreakdown: {},
      meetings: [] as CoachMeeting[],
      hasError: true,
      errorMessage: res.reason instanceof Error ? res.reason.message : 'İşlem sırasında beklenmedik hata oluştu',
    };
  });

  // Veritabanına kaydet
  await coachRepo.saveCoachPayrollBatch(recordsToSave);

  const updatedSummary = await getCoachPayrollSummary(period.month);
  return {
    summary: updatedSummary,
    syncedCount: updatedSummary.items.length,
    errorCount: updatedSummary.warningCoaches,
    message: `${updatedSummary.items.length} koç klasörü Google Drive'dan başarıyla senkronize edildi.`,
  };
}

/**
 * Kategori bazlı ücret baremlerini getirir.
 */
export async function getRates(): Promise<CoachRate[]> {
  return coachRepo.getCoachRates();
}

/**
 * Kategori bazlı ücret baremlerini günceller ve mevcut toplantıların ücretlerini yeniden hesaplar.
 */
export async function updateRates(
  rates: Array<{ categoryName: string; rate: number; currency?: string; description?: string }>,
  currentMonth?: string,
): Promise<{ rates: CoachRate[]; recalculated: boolean }> {
  const updatedRates = await coachRepo.upsertCoachRates(rates);

  // Eğer mevcut ay parametresi varsa mevcut kayıtları yeni baremlere göre yeniden hesapla
  let recalculated = false;
  if (currentMonth) {
    const records = await coachRepo.getCoachPayrollRecords(currentMonth);
    if (records.length > 0) {
      const rateMap = new Map<string, number>(updatedRates.map((r) => [r.categoryName, r.rate]));

      const recalculatedRecords = records.map((record) => {
        if (record.hasError || record.meetings.length === 0) return record;

        let totalAmount = 0;
        const meetings = record.meetings.map((m) => {
          const rate = rateMap.get(m.category) ?? rateMap.get('Diğer') ?? m.rate;
          totalAmount += rate;
          return { ...m, rate };
        });

        return {
          month: record.month,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          coachName: record.coachName,
          driveFolderId: record.driveFolderId,
          spreadsheetId: record.spreadsheetId,
          spreadsheetName: record.spreadsheetName,
          totalMeetings: meetings.length,
          totalAmount,
          categoryBreakdown: record.categoryBreakdown,
          meetings,
          hasError: record.hasError,
          errorMessage: record.errorMessage,
        };
      });

      await coachRepo.saveCoachPayrollBatch(recalculatedRecords);
      recalculated = true;
    }
  }

  return { rates: updatedRates, recalculated };
}
