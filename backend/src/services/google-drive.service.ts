/**
 * Google Drive API entegrasyon servisi.
 * Koçlar klasörünü tarar, her koçun "İşleyiş Tablosu" dosyasını tespit eder ve indirir.
 */
import { google, type drive_v3 } from 'googleapis';
import * as XLSX from 'xlsx';
import { config } from '../config.js';
import type { CoachMeeting } from '../types/api.js';

export interface DriveFolderItem {
  id: string;
  name: string;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
}

/** Google Drive API istemcisi oluşturur. */
export function getDriveClient(): drive_v3.Drive | null {
  const { serviceAccountEmail, privateKey } = config.google;
  if (!serviceAccountEmail || !privateKey) {
    return null;
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });

  return google.drive({ version: 'v3', auth });
}

export function isGoogleDriveConfigured(): boolean {
  return Boolean(
    config.google.serviceAccountEmail &&
    config.google.privateKey &&
    config.google.coachesFolderId,
  );
}

/** "Koçlar" ana klasörü altındaki tüm koç alt klasörlerini listeler. */
export async function listCoachFolders(drive: drive_v3.Drive, parentFolderId: string): Promise<DriveFolderItem[]> {
  const folders: DriveFolderItem[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
    });

    if (res.data.files) {
      for (const f of res.data.files) {
        if (f.id && f.name) {
          folders.push({ id: f.id, name: f.name.trim() });
        }
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return folders;
}

/** Koç klasöründe adı "İşleyiş Tablosu" içeren dosyayı tespit eder. */
export async function findWorksheetFile(drive: drive_v3.Drive, folderId: string): Promise<DriveFileItem | null> {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 50,
  });

  const files = res.data.files ?? [];
  // Türkçe karakter duyarsız eşleme: 'işleyiş', 'isleyis', 'isleyiş'
  const matched = files.find((f) => {
    if (!f.name) return false;
    const lower = f.name.toLocaleLowerCase('tr-TR');
    return lower.includes('işleyiş') || lower.includes('isleyis') || lower.includes('isleyi');
  });

  if (!matched || !matched.id || !matched.name) {
    return null;
  }

  return {
    id: matched.id,
    name: matched.name,
    mimeType: matched.mimeType ?? 'application/octet-stream',
  };
}

/** Dosyayı bellek üzerine indirir veya Google Sheets ise xlsx olarak export eder. */
export async function downloadFileBuffer(drive: drive_v3.Drive, file: DriveFileItem): Promise<Buffer> {
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const exportRes = await drive.files.export(
      {
        fileId: file.id,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(exportRes.data as ArrayBuffer);
  }

  const getRes = await drive.files.get(
    {
      fileId: file.id,
      alt: 'media',
    },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(getRes.data as ArrayBuffer);
}

/** Excel seri tarihini veya metin formatındaki tarihi YYYY-MM-DD formatına dönüştürür. */
export function normalizeDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;

  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }

  // Sayısal Excel Serial Date (örn: 45340)
  if (typeof val === 'number') {
    // Excel epoch 1899-12-30
    const parsed = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const str = String(val).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // DD.MM.YYYY veya DD/MM/YYYY veya DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmyMatch && dmyMatch[1] && dmyMatch[2] && dmyMatch[3]) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // YYYY/MM/DD
  const ymdMatch = str.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymdMatch && ymdMatch[1] && ymdMatch[2] && ymdMatch[3]) {
    const year = ymdMatch[1];
    const month = ymdMatch[2].padStart(2, '0');
    const day = ymdMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return null;
}

/** Toplantı kategorisini bilinen ana kategorilere eşler. */
export function normalizeCategory(rawCat: string, availableCategories: string[]): string {
  const clean = (rawCat || '').trim();
  if (!clean) return 'Diğer';

  const lower = clean.toLocaleLowerCase('tr-TR');

  // Mevcut kategorilerle tam veya kapsayıcı eşleşme
  for (const cat of availableCategories) {
    const catLower = cat.toLocaleLowerCase('tr-TR');
    if (lower === catLower || lower.includes(catLower) || catLower.includes(lower)) {
      return cat;
    }
  }

  if (lower.includes('bireysel') || lower.includes('özel') || lower.includes('birebir') || lower.includes('1-1')) {
    const found = availableCategories.find((c) => c.toLocaleLowerCase('tr-TR').includes('bireysel'));
    return found ?? 'Bireysel';
  }
  if (lower.includes('grup') || lower.includes('atölye') || lower.includes('atolye') || lower.includes('kamp')) {
    const found = availableCategories.find((c) => c.toLocaleLowerCase('tr-TR').includes('grup'));
    return found ?? 'Grup';
  }
  if (lower.includes('deneme') || lower.includes('tanışma') || lower.includes('tanisma') || lower.includes('ilk')) {
    const found = availableCategories.find((c) => c.toLocaleLowerCase('tr-TR').includes('deneme'));
    return found ?? 'Deneme';
  }
  if (lower.includes('veli') || lower.includes('aile')) {
    const found = availableCategories.find((c) => c.toLocaleLowerCase('tr-TR').includes('veli'));
    return found ?? 'Veli Görüşmesi';
  }

  const defaultCat = availableCategories.find((c) => c.toLocaleLowerCase('tr-TR').includes('diğer')) ?? 'Diğer';
  return defaultCat;
}

/**
 * Excel dosyasındaki Zoom Toplantıları sekmesini okur ve verilen tarih aralığındaki kayıtları çıkarır.
 */
export function parseWorksheetMeetings(
  buffer: Buffer,
  periodStart: string,
  periodEnd: string,
  rateMap: Map<string, number>,
): {
  meetings: CoachMeeting[];
  categoryBreakdown: Record<string, number>;
  totalAmount: number;
} {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetNames = workbook.SheetNames;

  // Zoom sekmesini bul: 'Zoom Toplantıları', 'Zoom', 'Toplantılar', 'Görüşmeler'
  let targetSheetName = sheetNames.find((name) => {
    const lower = name.toLocaleLowerCase('tr-TR');
    return lower.includes('zoom');
  });

  if (!targetSheetName) {
    targetSheetName = sheetNames.find((name) => {
      const lower = name.toLocaleLowerCase('tr-TR');
      return lower.includes('toplantı') || lower.includes('toplanti') || lower.includes('görüşme') || lower.includes('gorusme');
    });
  }

  // Sekme bulunamazsa ilk sekme kullanılır
  if (!targetSheetName && sheetNames.length > 0) {
    targetSheetName = sheetNames[0];
  }

  if (!targetSheetName) {
    throw new Error('Excel dosyasında okunabilecek sayfa bulunamadı.');
  }

  const sheet = workbook.Sheets[targetSheetName];
  if (!sheet) {
    return { meetings: [], categoryBreakdown: {}, totalAmount: 0 };
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  if (!rows || rows.length === 0) {
    return { meetings: [], categoryBreakdown: {}, totalAmount: 0 };
  }

  // Başlık satırını tespit et (ilk 15 satır taranır)
  let headerRowIndex = -1;
  let dateCol = -1;
  let timeCol = -1;
  let topicCol = -1;
  let categoryCol = -1;

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').trim().toLocaleLowerCase('tr-TR');
      if (cell.includes('tarih') || cell.includes('gün') || cell.includes('gun') || cell === 'date') {
        dateCol = c;
      } else if (cell.includes('saat') || cell.includes('zaman') || cell.includes('time')) {
        timeCol = c;
      } else if (
        cell.includes('öğrenci') ||
        cell.includes('ogrenci') ||
        cell.includes('konu') ||
        cell.includes('danışan') ||
        cell.includes('katılımcı') ||
        cell.includes('başlık') ||
        cell.includes('toplantı')
      ) {
        topicCol = c;
      } else if (cell.includes('kategori') || cell.includes('tür') || cell.includes('tur') || cell.includes('tip')) {
        categoryCol = c;
      }
    }

    if (dateCol !== -1) {
      headerRowIndex = i;
      break;
    }
  }

  // Başlık satırı net tespit edilemediyse varsayılan indeksler
  if (headerRowIndex === -1) {
    headerRowIndex = 0;
    dateCol = 0;
    timeCol = 1;
    topicCol = 2;
    categoryCol = 3;
  } else {
    if (timeCol === -1) timeCol = dateCol + 1;
    if (topicCol === -1) topicCol = dateCol + 2;
    if (categoryCol === -1) categoryCol = dateCol + 3;
  }

  const availableCategories = Array.from(rateMap.keys());
  const meetings: CoachMeeting[] = [];
  const categoryBreakdown: Record<string, number> = {};
  let totalAmount = 0;

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const rawDate = row[dateCol];
    const parsedDate = normalizeDate(rawDate);
    if (!parsedDate) continue;

    // Filtre: [Geçen Ay 15, 00:00:00] ile [Bu Ay 15, 23:59:59]
    if (parsedDate < periodStart || parsedDate > periodEnd) {
      continue;
    }

    const rawTime = timeCol < row.length ? String(row[timeCol] || '').trim() : '';
    const rawTopic = topicCol < row.length ? String(row[topicCol] || '').trim() : 'Görüşme';
    const rawCategory = categoryCol < row.length ? String(row[categoryCol] || '').trim() : '';

    const category = normalizeCategory(rawCategory, availableCategories);
    const rate = rateMap.get(category) ?? rateMap.get('Diğer') ?? 400;

    const meeting: CoachMeeting = {
      id: `m-${r}-${parsedDate}`,
      date: parsedDate,
      time: rawTime || undefined,
      topic: rawTopic || 'Öğrenci Görüşmesi',
      category,
      rate,
    };

    meetings.push(meeting);
    categoryBreakdown[category] = (categoryBreakdown[category] ?? 0) + 1;
    totalAmount += rate;
  }

  // Toplantıları tarihe göre artan sırala
  meetings.sort((a, b) => a.date.localeCompare(b.date));

  return {
    meetings,
    categoryBreakdown,
    totalAmount,
  };
}
