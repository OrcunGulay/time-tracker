-- =============================================================================
--  004_coach_payroll.sql - Koç Hakediş / Ödeme Yönetimi ve Baremler
-- =============================================================================

BEGIN;

-- 1. Kategori bazlı koçluk ücret baremleri
CREATE TABLE IF NOT EXISTS coach_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name text NOT NULL UNIQUE,
  rate          numeric(12,2) NOT NULL CHECK (rate >= 0),
  currency      char(3) NOT NULL DEFAULT 'TRY',
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Varsayılan baremler
INSERT INTO coach_rates (category_name, rate, currency, description)
VALUES
  ('Bireysel', 500.00, 'TRY', 'Bireysel öğrenci koçluğu seansı'),
  ('Grup', 750.00, 'TRY', 'Grup koçluk ve atölye çalışması'),
  ('Deneme', 350.00, 'TRY', 'Tanışma ve deneme koçluk seansı'),
  ('Veli Görüşmesi', 300.00, 'TRY', 'Veli bilgilendirme ve rehberlik görüşmesi'),
  ('Diğer', 400.00, 'TRY', 'Genel veya kategorisi belirtilmemiş toplantı')
ON CONFLICT (category_name) DO NOTHING;

-- 2. Senkronize edilen koç hakediş kayıtları
CREATE TABLE IF NOT EXISTS coach_payroll_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month              varchar(7) NOT NULL, -- 'YYYY-MM'
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  coach_name         text NOT NULL,
  drive_folder_id    text,
  spreadsheet_id     text,
  spreadsheet_name   text,
  total_meetings     integer NOT NULL DEFAULT 0,
  total_amount       numeric(14,2) NOT NULL DEFAULT 0,
  category_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  meetings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_error          boolean NOT NULL DEFAULT false,
  error_message      text,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coach_payroll_month_coach_uidx UNIQUE (month, coach_name)
);

CREATE INDEX IF NOT EXISTS coach_payroll_month_idx ON coach_payroll_records (month);
CREATE INDEX IF NOT EXISTS coach_payroll_coach_name_idx ON coach_payroll_records (lower(coach_name));

-- Örnek veri (2026-03 dönemi için: 15 Şubat 2026 - 15 Mart 2026)
INSERT INTO coach_payroll_records (
  month, period_start, period_end, coach_name, drive_folder_id, spreadsheet_id, spreadsheet_name,
  total_meetings, total_amount, category_breakdown, meetings, has_error, error_message
)
VALUES
(
  '2026-03', '2026-02-15', '2026-03-15', 'Selin Yılmaz',
  'drive_folder_selin', 'sheet_selin_01', 'İşleyiş Tablosu - Selin Yılmaz.xlsx',
  16, 8900.00,
  '{"Bireysel": 11, "Grup": 3, "Veli Görüşmesi": 2}'::jsonb,
  '[
    {"id": "m-selin-1", "date": "2026-02-16", "time": "14:00", "topic": "Kaan Kaya - Matematik Takip", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-2", "date": "2026-02-18", "time": "16:30", "topic": "YKS 12. Sınıf Çalışma Grubu", "category": "Grup", "rate": 750},
    {"id": "m-selin-3", "date": "2026-02-21", "time": "11:00", "topic": "Elif Demir - Haftalık Planlama", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-4", "date": "2026-02-23", "time": "18:00", "topic": "Kaan Kaya Veli Görüşmesi", "category": "Veli Görüşmesi", "rate": 300},
    {"id": "m-selin-5", "date": "2026-02-26", "time": "15:00", "topic": "Cemre Ak - Hedef Belirleme", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-6", "date": "2026-03-01", "time": "17:00", "topic": "Deneme Sınavı Analizi Grubu", "category": "Grup", "rate": 750},
    {"id": "m-selin-7", "date": "2026-03-03", "time": "13:30", "topic": "Deniz Kara - Biyoloji & Kimya", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-8", "date": "2026-03-06", "time": "15:30", "topic": "Elif Demir Veli Ara Değerlendirme", "category": "Veli Görüşmesi", "rate": 300},
    {"id": "m-selin-9", "date": "2026-03-08", "time": "10:00", "topic": "Mert Yıldız - Paragraf & Hızlı Okuma", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-10", "date": "2026-03-10", "time": "14:00", "topic": "Motivasyon & Stres Yönetimi", "category": "Grup", "rate": 750},
    {"id": "m-selin-11", "date": "2026-03-12", "time": "16:00", "topic": "Kaan Kaya - Soru Çözüm Analizi", "category": "Bireysel", "rate": 500},
    {"id": "m-selin-12", "date": "2026-03-14", "time": "11:30", "topic": "Elif Demir - Deneme Sonuçları", "category": "Bireysel", "rate": 500}
  ]'::jsonb,
  false, null
),
(
  '2026-03', '2026-02-15', '2026-03-15', 'Can Demir',
  'drive_folder_can', 'sheet_can_01', 'İşleyiş Tablosu - Can Demir.xlsx',
  14, 7650.00,
  '{"Bireysel": 9, "Grup": 2, "Deneme": 2, "Veli Görüşmesi": 1}'::jsonb,
  '[
    {"id": "m-can-1", "date": "2026-02-17", "time": "13:00", "topic": "Arda Şahin - LGS Matematik", "category": "Bireysel", "rate": 500},
    {"id": "m-can-2", "date": "2026-02-19", "time": "15:00", "topic": "Yeni Kayıt Tanışma - Berke", "category": "Deneme", "rate": 350},
    {"id": "m-can-3", "date": "2026-02-22", "time": "17:30", "topic": "LGS Fen & Mantık Atölyesi", "category": "Grup", "rate": 750},
    {"id": "m-can-4", "date": "2026-02-25", "time": "14:00", "topic": "Selin Aydın - Haftalık Program", "category": "Bireysel", "rate": 500},
    {"id": "m-can-5", "date": "2026-02-28", "time": "16:00", "topic": "Arda Şahin Veli Görüşmesi", "category": "Veli Görüşmesi", "rate": 300},
    {"id": "m-can-6", "date": "2026-03-02", "time": "11:00", "topic": "Yeni Kayıt Tanışma - Melis", "category": "Deneme", "rate": 350},
    {"id": "m-can-7", "date": "2026-03-05", "time": "18:00", "topic": "LGS Genel Deneme Değerlendirme", "category": "Grup", "rate": 750},
    {"id": "m-can-8", "date": "2026-03-09", "time": "14:30", "topic": "Selin Aydın - Türkçe Kampı", "category": "Bireysel", "rate": 500},
    {"id": "m-can-9", "date": "2026-03-13", "time": "16:00", "topic": "Arda Şahin - Zaman Yönetimi", "category": "Bireysel", "rate": 500}
  ]'::jsonb,
  false, null
),
(
  '2026-03', '2026-02-15', '2026-03-15', 'Zeynep Kaya',
  'drive_folder_zeynep', 'sheet_zeynep_01', 'İşleyiş Tablosu - Zeynep Kaya.xlsx',
  18, 9850.00,
  '{"Bireysel": 13, "Grup": 3, "Deneme": 1, "Veli Görüşmesi": 1}'::jsonb,
  '[
    {"id": "m-zeynep-1", "date": "2026-02-16", "time": "10:30", "topic": "Yağmur Koç - TYT Türkçe", "category": "Bireysel", "rate": 500},
    {"id": "m-zeynep-2", "date": "2026-02-18", "time": "15:00", "topic": "Hızlı Paragraf Çözüm Teknikleri", "category": "Grup", "rate": 750},
    {"id": "m-zeynep-3", "date": "2026-02-20", "time": "13:00", "topic": "Deneme Seansı - Umut Karaca", "category": "Deneme", "rate": 350},
    {"id": "m-zeynep-4", "date": "2026-02-24", "time": "16:30", "topic": "Yağmur Koç Veli Bilgilendirme", "category": "Veli Görüşmesi", "rate": 300},
    {"id": "m-zeynep-5", "date": "2026-02-27", "time": "11:00", "topic": "Burak Tan - Geometri Takip", "category": "Bireysel", "rate": 500},
    {"id": "m-zeynep-6", "date": "2026-03-04", "time": "14:00", "topic": "AYT Edebiyat Soru Çözümü", "category": "Grup", "rate": 750},
    {"id": "m-zeynep-7", "date": "2026-03-07", "time": "17:00", "topic": "Burak Tan - Deneme Analizi", "category": "Bireysel", "rate": 500},
    {"id": "m-zeynep-8", "date": "2026-03-11", "time": "15:30", "topic": "Yağmur Koç - Genel Tekrar", "category": "Bireysel", "rate": 500}
  ]'::jsonb,
  false, null
),
(
  '2026-03', '2026-02-15', '2026-03-15', 'Burak Öztürk',
  'drive_folder_burak', 'sheet_burak_01', 'İşleyiş Tablosu - Burak Öztürk.xlsx',
  10, 5600.00,
  '{"Bireysel": 6, "Grup": 2, "Veli Görüşmesi": 2}'::jsonb,
  '[
    {"id": "m-burak-1", "date": "2026-02-19", "time": "14:00", "topic": "Emre Güler - Fizik 12", "category": "Bireysel", "rate": 500},
    {"id": "m-burak-2", "date": "2026-02-22", "time": "18:00", "topic": "Elektrik ve Manyetizma Kampı", "category": "Grup", "rate": 750},
    {"id": "m-burak-3", "date": "2026-03-01", "time": "15:00", "topic": "Emre Güler Veli Raporlama", "category": "Veli Görüşmesi", "rate": 300},
    {"id": "m-burak-4", "date": "2026-03-08", "time": "11:00", "topic": "Emre Güler - AYT Deneme Analizi", "category": "Bireysel", "rate": 500}
  ]'::jsonb,
  false, null
),
(
  '2026-03', '2026-02-15', '2026-03-15', 'Elif Arslan',
  'drive_folder_elif', null, null,
  0, 0.00,
  '{}'::jsonb,
  '[]'::jsonb,
  true, 'Klasörde "İşleyiş Tablosu" formatında dosya bulunamadı.'
)
ON CONFLICT (month, coach_name) DO UPDATE SET
  total_meetings = EXCLUDED.total_meetings,
  total_amount = EXCLUDED.total_amount,
  category_breakdown = EXCLUDED.category_breakdown,
  meetings = EXCLUDED.meetings,
  has_error = EXCLUDED.has_error,
  error_message = EXCLUDED.error_message,
  synced_at = now();

COMMIT;
