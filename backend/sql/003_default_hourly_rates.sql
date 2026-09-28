-- =============================================================================
--  003_default_hourly_rates.sql - Saatlik ucret ve aktiflik duzeltmesi
-- =============================================================================

BEGIN;

-- 1. Saatlik ucreti 0 veya NULL olan mevcut kullanicilara varsayilan ucret ata
UPDATE users
SET hourly_rate = 600
WHERE hourly_rate = 0 OR hourly_rate IS NULL;

-- 2. Bilinen kullanicilarin saatlik ucretlerini ve aktifliklerini guncelle
UPDATE users
SET hourly_rate = 850, is_active = true
WHERE lower(email) = 'deniz@localhost';

UPDATE users
SET hourly_rate = 600, is_active = true
WHERE lower(email) = 'ada@localhost';

UPDATE users
SET hourly_rate = 550, is_active = true
WHERE lower(email) = 'mert@localhost';

UPDATE users
SET hourly_rate = 750, is_active = true
WHERE lower(email) = 'admin@localhost';

-- Diger admin ve calisanlarin aktifligini sagla
UPDATE users
SET is_active = true
WHERE is_active = false;

-- Varsayilan saatlik ucreti 500 olarak guncelle
ALTER TABLE users ALTER COLUMN hourly_rate SET DEFAULT 500;

COMMIT;
