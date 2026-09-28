-- =============================================================================
--  001_init.sql - Aktivite & Zaman Takip Platformu temel semasi
--  PostgreSQL 17
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enum tipleri
DO $$ BEGIN
  CREATE TYPE user_role      AS ENUM ('admin', 'manager', 'employee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status    AS ENUM ('todo', 'in_progress', 'blocked', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_status AS ENUM ('active', 'stopped', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE productivity_category AS ENUM ('PRODUCTIVE', 'UNPRODUCTIVE', 'NEUTRAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE category_match_type AS ENUM ('app', 'domain');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE idle_decision AS ENUM ('count', 'discard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  email          text        NOT NULL,
  password_hash  text        NOT NULL,
  role           user_role   NOT NULL DEFAULT 'employee',
  department     text,
  timezone       text        NOT NULL DEFAULT 'Europe/Istanbul',
  -- Bordro: saatlik brut ucret ve para birimi
  hourly_rate    numeric(12,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  currency       char(3)     NOT NULL DEFAULT 'TRY',
  -- Desktop agent API anahtari (hash'lenmis saklanir, ham deger yalnizca uretimde bir kez gosterilir)
  agent_api_key_hash text,
  is_active      boolean     NOT NULL DEFAULT true,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Email tekilligi buyuk/kucuk harfe duyarsiz olmali
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role) WHERE is_active;
CREATE INDEX IF NOT EXISTS users_agent_key_idx ON users (agent_api_key_hash) WHERE agent_api_key_hash IS NOT NULL;

-- ------------------------------------------------------------------ projects
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  description text,
  is_archived boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_lower_uidx ON projects (lower(name));

-- Proje uyeleri: bir calisan birden fazla projede olabilir
CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- --------------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title       text        NOT NULL,
  description text,
  status      task_status NOT NULL DEFAULT 'todo',
  is_billable boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id, status);

-- ------------------------------------------------------------------ sessions
-- Bir "mesai" oturumu. total_duration = end - start; idle/productive ayri tutulur.
CREATE TABLE IF NOT EXISTS sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id         uuid           REFERENCES projects (id) ON DELETE SET NULL,
  task_id            uuid           REFERENCES tasks (id)    ON DELETE SET NULL,
  start_time         timestamptz    NOT NULL,
  end_time           timestamptz,
  -- saniye cinsinden toplamlar (agent bildirimleri + server hesaplari)
  total_duration     integer        NOT NULL DEFAULT 0,
  idle_duration      integer        NOT NULL DEFAULT 0,
  productive_seconds integer        NOT NULL DEFAULT 0,
  unproductive_seconds integer      NOT NULL DEFAULT 0,
  neutral_seconds    integer        NOT NULL DEFAULT 0,
  -- Ekran goruntusu silme protokolu ile dusulen sure
  deducted_seconds   integer        NOT NULL DEFAULT 0,
  -- Calisanin "bu sureyi calisilmis say" dedigi bosluklar (odenebilir sureye geri eklenir)
  credited_seconds   integer        NOT NULL DEFAULT 0,
  -- Odenebilir sure = total - idle - deducted + credited (tek dogruluk kaynagi SQL'de)
  status             session_status NOT NULL DEFAULT 'active',
  -- Payroll: onaylanan saatler faturalanir
  approved_by        uuid           REFERENCES users (id) ON DELETE SET NULL,
  approved_at        timestamptz,
  client_started_at  timestamptz,
  client_info        jsonb          NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT sessions_time_order CHECK (end_time IS NULL OR end_time >= start_time)
);

CREATE INDEX IF NOT EXISTS sessions_user_start_idx ON sessions (user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS sessions_active_idx     ON sessions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS sessions_project_idx    ON sessions (project_id, start_time DESC);
-- Ayni kullanici icin ayni anda tek aktif oturum (race condition korumasi)
CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_active_uidx
  ON sessions (user_id) WHERE status = 'active';

-- ------------------------------------------------------------- activity_logs
-- Ham pencere/uygulama aktivitesi (KLAVYE ICERIGI ASLA SAKLANMAZ).
CREATE TABLE IF NOT EXISTS activity_logs (
  id               bigserial PRIMARY KEY,
  session_id       uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  timestamp        timestamptz NOT NULL,
  -- Bos string = "bilinmiyor"; NULL yerine '' kullaniyoruz ki tekrar gonderilen
  -- offline batch'leri ON CONFLICT ile guvenle tekillestirilebilsin.
  active_app       text        NOT NULL DEFAULT '',
  window_title     text        NOT NULL DEFAULT '',
  -- URL seviyesinde takip (browser extension / AX API)
  url              text,
  domain           text,
  monitor_index    smallint    NOT NULL DEFAULT 0,
  mouse_events     integer     NOT NULL DEFAULT 0 CHECK (mouse_events >= 0),
  keyboard_events  integer     NOT NULL DEFAULT 0 CHECK (keyboard_events >= 0),
  -- piksel cinsinden fare hareket mesafesi
  mouse_distance   integer     NOT NULL DEFAULT 0 CHECK (mouse_distance >= 0),
  is_idle          boolean     NOT NULL DEFAULT false,
  idle_seconds     integer     NOT NULL DEFAULT 0,
  -- Bu ornegin temsil ettigi sure (agirlikli skor icin kritik)
  duration_seconds integer     NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0 AND duration_seconds <= 3600),
  -- uretkenlik motorunun o an uyguladigi etiket
  category         productivity_category NOT NULL DEFAULT 'NEUTRAL',
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Offline agent tekrar gonderimlerinde mukerrer kayit olmamasi icin (idempotent batch)
  CONSTRAINT activity_logs_unique_sample UNIQUE (session_id, timestamp)
);

CREATE INDEX IF NOT EXISTS activity_logs_session_ts_idx ON activity_logs (session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS activity_logs_user_ts_idx    ON activity_logs (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS activity_logs_domain_idx     ON activity_logs (user_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_logs_app_idx        ON activity_logs (user_id, active_app) WHERE active_app IS NOT NULL;

-- ------------------------------------------------------------- screenshots
CREATE TABLE IF NOT EXISTS screenshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  timestamp          timestamptz NOT NULL,
  storage_key        text        NOT NULL,
  storage_url        text,
  content_type       text        NOT NULL DEFAULT 'image/webp',
  size_bytes         bigint      NOT NULL DEFAULT 0,
  width              integer,
  height             integer,
  monitor_index      smallint    NOT NULL DEFAULT 0,
  monitor_name       text,
  blur_applied       boolean     NOT NULL DEFAULT false,
  -- Gizlilik protokolu: calisan kendi gorselini silerse
  deleted_by_employee boolean    NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  deducted_seconds   integer     NOT NULL DEFAULT 0,
  uploaded_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Offline kuyrugundan ayni kareyi iki kez gonderme korumasi
  CONSTRAINT screenshots_unique_frame UNIQUE (session_id, timestamp, monitor_index)
);

CREATE INDEX IF NOT EXISTS screenshots_session_ts_idx ON screenshots (session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS screenshots_user_ts_idx    ON screenshots (user_id, timestamp DESC)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------- app/url kategori kurallari
-- Uretkenlik motoru: global veya departman bazli etiketler.
CREATE TABLE IF NOT EXISTS category_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type  category_match_type NOT NULL,
  -- 'chrome.exe' veya 'youtube.com' (kucuk harf, wildcard icin * desteklenir)
  pattern     text        NOT NULL,
  category    productivity_category NOT NULL,
  -- NULL = global kural, dolu = sadece o departman
  department  text,
  project_id  uuid        REFERENCES projects (id) ON DELETE CASCADE,
  priority    integer     NOT NULL DEFAULT 100,
  is_active   boolean     NOT NULL DEFAULT true,
  notes       text,
  created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_rules_unique UNIQUE (match_type, pattern, department)
);

CREATE INDEX IF NOT EXISTS category_rules_lookup_idx
  ON category_rules (match_type, is_active, priority DESC);
CREATE UNIQUE INDEX IF NOT EXISTS category_rules_global_uidx
  ON category_rules (match_type, pattern) WHERE department IS NULL;

-- ------------------------------------------------------------------ idle_events
-- Idle popup sonucu: sure sayilsin mi silinsin mi?
CREATE TABLE IF NOT EXISTS idle_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  idle_seconds integer     NOT NULL DEFAULT 0,
  decision     idle_decision,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idle_events_session_idx ON idle_events (session_id, started_at DESC);

-- -------------------------------------------------------------- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
  actor_role  user_role,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- ------------------------------------------------------------------ payroll_runs
-- Donmus (faturalanmis) bordro donemleri
CREATE TABLE IF NOT EXISTS payroll_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_start  date        NOT NULL,
  period_end    date        NOT NULL,
  total_seconds integer     NOT NULL DEFAULT 0,
  billable_seconds integer  NOT NULL DEFAULT 0,
  hourly_rate   numeric(12,2) NOT NULL DEFAULT 0,
  currency      char(3)     NOT NULL DEFAULT 'TRY',
  amount        numeric(14,2) NOT NULL DEFAULT 0,
  status        text        NOT NULL DEFAULT 'draft',  -- draft | issued | paid
  issued_at     timestamptz,
  paid_at       timestamptz,
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_runs_period_order CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS payroll_runs_user_period_idx ON payroll_runs (user_id, period_start DESC);

-- --------------------------------------------------------------- refresh_tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','tasks','sessions','category_rules'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

COMMIT;
