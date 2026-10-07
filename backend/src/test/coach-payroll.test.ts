import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { resolveCoachPeriod } from '../services/coach-payroll.service.js';
import {
  normalizeCategory,
  normalizeDate,
  parseWorksheetMeetings,
} from '../services/google-drive.service.js';

describe('resolveCoachPeriod', () => {
  it('iki ayin 15i arasindaki donemi dogru hesaplar', () => {
    const period = resolveCoachPeriod('2026-03');
    assert.equal(period.month, '2026-03');
    assert.equal(period.periodStart, '2026-02-15');
    assert.equal(period.periodEnd, '2026-03-15');
    assert.equal(period.periodLabel, '15 Şubat 2026 – 15 Mart 2026');
  });

  it('yil basinda (Ocak) gecen yilin Aralik ayina dogru gecis yapar', () => {
    const period = resolveCoachPeriod('2026-01');
    assert.equal(period.month, '2026-01');
    assert.equal(period.periodStart, '2025-12-15');
    assert.equal(period.periodEnd, '2026-01-15');
    assert.equal(period.periodLabel, '15 Aralık 2025 – 15 Ocak 2026');
  });
});

describe('normalizeDate', () => {
  it('YYYY-MM-DD formatini oldugu gibi korur', () => {
    assert.equal(normalizeDate('2026-02-18'), '2026-02-18');
  });

  it('DD.MM.YYYY formatini ISO formata cevirir', () => {
    assert.equal(normalizeDate('18.02.2026'), '2026-02-18');
    assert.equal(normalizeDate('5.3.2026'), '2026-03-05');
  });

  it('DD/MM/YYYY formatini ISO formata cevirir', () => {
    assert.equal(normalizeDate('24/02/2026'), '2026-02-24');
  });

  it('Date objelerini dogru cozumler', () => {
    const date = new Date(Date.UTC(2026, 1, 20));
    assert.equal(normalizeDate(date), '2026-02-20');
  });

  it('Gecersiz degerler icin null doner', () => {
    assert.equal(normalizeDate(''), null);
    assert.equal(normalizeDate(null), null);
    assert.equal(normalizeDate('bilinmeyen'), null);
  });
});

describe('normalizeCategory', () => {
  const categories = ['Bireysel', 'Grup', 'Deneme', 'Veli Görüşmesi', 'Diğer'];

  it('tam eslesmelerde kategoriyi aynen dondurur', () => {
    assert.equal(normalizeCategory('Bireysel', categories), 'Bireysel');
    assert.equal(normalizeCategory('grup', categories), 'Grup');
  });

  it('varyasyonlari dogru ana kategoriye esler', () => {
    assert.equal(normalizeCategory('Bireysel Koçluk Görüşmesi', categories), 'Bireysel');
    assert.equal(normalizeCategory('Haftalık Grup Atölyesi', categories), 'Grup');
    assert.equal(normalizeCategory('İlk Deneme Seansı', categories), 'Deneme');
    assert.equal(normalizeCategory('Veli Bilgilendirme Toplantısı', categories), 'Veli Görüşmesi');
  });

  it('bilinmeyen kategoriyi Diger kategorisine esler', () => {
    assert.equal(normalizeCategory('Rastgele Sohbet', categories), 'Diğer');
    assert.equal(normalizeCategory('', categories), 'Diğer');
  });
});

describe('parseWorksheetMeetings', () => {
  it('Zoom sekmesindeki toplantilari ve hakedisi dogru hesaplar', () => {
    const rateMap = new Map<string, number>([
      ['Bireysel', 500],
      ['Grup', 750],
      ['Deneme', 350],
      ['Veli Görüşmesi', 300],
      ['Diğer', 400],
    ]);

    // Bellekte test Excel calisma kitabi olustur
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['Tarih', 'Saat', 'Öğrenci / Konu', 'Kategori', 'Notlar'],
      ['10.02.2026', '14:00', 'Erken Toplantı (aralık dışı)', 'Bireysel', ''],
      ['16.02.2026', '14:00', 'Kaan Kaya - Matematik', 'Bireysel', 'Tamamlandı'],
      ['18.02.2026', '16:30', '12. Sınıf Çalışma Grubu', 'Grup', 'Online'],
      ['25.02.2026', '18:00', 'Kaan Kaya Veli', 'Veli Görüşmesi', ''],
      ['20.03.2026', '11:00', 'Geç Toplantı (aralık dışı)', 'Bireysel', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Zoom Toplantıları');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = parseWorksheetMeetings(buffer, '2026-02-15', '2026-03-15', rateMap);

    // Yalnizca 15 Subat - 15 Mart arasindaki 3 toplanti alinmali
    assert.equal(result.meetings.length, 3);
    assert.equal(result.categoryBreakdown['Bireysel'], 1);
    assert.equal(result.categoryBreakdown['Grup'], 1);
    assert.equal(result.categoryBreakdown['Veli Görüşmesi'], 1);

    // Tutar: 500 (Bireysel) + 750 (Grup) + 300 (Veli) = 1550
    assert.equal(result.totalAmount, 1550);

    const firstMeeting = result.meetings[0];
    assert.ok(firstMeeting);
    assert.equal(firstMeeting.date, '2026-02-16');
    assert.equal(firstMeeting.topic, 'Kaan Kaya - Matematik');
    assert.equal(firstMeeting.rate, 500);
  });
});

describe('extractCoachNameFromFilename', () => {
  it('dosya adindan koc adini dogru cikarir', async () => {
    const { extractCoachNameFromFilename } = await import('../services/archive-parser.service.js');
    assert.equal(extractCoachNameFromFilename('İşleyiş Tablosu - Ahmet Yılmaz.xlsx'), 'Ahmet Yılmaz');
    assert.equal(extractCoachNameFromFilename('Selin Yılmaz - isleyis tablosu.xlsx'), 'Selin Yılmaz');
    assert.equal(extractCoachNameFromFilename('Can Demir.xlsx'), 'Can Demir');
  });
});

