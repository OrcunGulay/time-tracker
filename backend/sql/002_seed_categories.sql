-- =============================================================================
--  002_seed_defaults.sql - Varsayilan kategori kurallari (urelkenlik motoru)
--  Tekrar calistirilabilir (idempotent).
-- =============================================================================

BEGIN;

INSERT INTO category_rules (match_type, pattern, category, priority, notes) VALUES
  -- --- Uygulamalar: uretken ---
  ('app', 'code',            'PRODUCTIVE',   10, 'VS Code'),
  ('app', 'code.exe',        'PRODUCTIVE',   10, 'VS Code (Windows)'),
  ('app', 'cursor',          'PRODUCTIVE',   10, 'Cursor IDE'),
  ('app', 'idea',            'PRODUCTIVE',   10, 'JetBrains IntelliJ'),
  ('app', 'pycharm',         'PRODUCTIVE',   10, 'JetBrains PyCharm'),
  ('app', 'webstorm',        'PRODUCTIVE',   10, 'JetBrains WebStorm'),
  ('app', 'terminal',        'PRODUCTIVE',   20, 'macOS/Linux terminal'),
  ('app', 'iterm2',          'PRODUCTIVE',   20, 'iTerm'),
  ('app', 'windows terminal','PRODUCTIVE',   20, 'Windows Terminal'),
  ('app', 'docker',          'PRODUCTIVE',   20, 'Docker Desktop'),
  ('app', 'postman',         'PRODUCTIVE',   20, 'API test'),
  ('app', 'figma',           'PRODUCTIVE',   20, 'Tasarim'),
  ('app', 'slack',           'NEUTRAL',      50, 'Iletisim'),
  ('app', 'teams',           'NEUTRAL',      50, 'Iletisim'),
  ('app', 'zoom',            'NEUTRAL',      50, 'Toplanti'),
  ('app', 'excel',           'PRODUCTIVE',   30, 'Ofis'),
  ('app', 'word',            'PRODUCTIVE',   30, 'Ofis'),
  ('app', 'notion',          'PRODUCTIVE',   30, 'Not'),
  ('app', 'spotify',         'NEUTRAL',      70, 'Muzik'),
  ('app', 'finder',          'NEUTRAL',      80, 'Dosya yonetimi'),
  ('app', 'explorer',        'NEUTRAL',      80, 'Dosya yonetimi'),
  ('app', 'steam',           'UNPRODUCTIVE',  5, 'Oyun'),
  ('app', 'discord',         'UNPRODUCTIVE', 40, 'Sohbet'),
  ('app', 'netflix',         'UNPRODUCTIVE',  5, 'Video'),
  -- --- Domainler: uretken ---
  ('domain', 'github.com',        'PRODUCTIVE',   10, 'Kod barindirma'),
  ('domain', 'gitlab.com',        'PRODUCTIVE',   10, 'Kod barindirma'),
  ('domain', 'stackoverflow.com', 'PRODUCTIVE',   10, 'Arastirma'),
  ('domain', 'developer.mozilla.org', 'PRODUCTIVE', 10, 'Dokumantasyon'),
  ('domain', 'docs.google.com',   'PRODUCTIVE',   20, 'Dokumantasyon'),
  ('domain', 'npmjs.com',         'PRODUCTIVE',   20, 'Paket'),
  ('domain', '*.atlassian.net',   'PRODUCTIVE',   20, 'Jira/Confluence'),
  ('domain', 'linear.app',        'PRODUCTIVE',   20, 'Issue tracking'),
  ('domain', 'chatgpt.com',       'NEUTRAL',      50, 'AI arac'),
  ('domain', 'claude.ai',         'NEUTRAL',      50, 'AI arac'),
  ('domain', 'linkedin.com',      'NEUTRAL',      60, 'Ag'),
  ('domain', 'localhost',         'PRODUCTIVE',   10, 'Yerel gelistirme'),
  -- --- Domainler: uretken degil ---
  ('domain', 'youtube.com',       'UNPRODUCTIVE', 10, 'Video'),
  ('domain', 'instagram.com',     'UNPRODUCTIVE', 10, 'Sosyal medya'),
  ('domain', 'facebook.com',      'UNPRODUCTIVE', 10, 'Sosyal medya'),
  ('domain', 'x.com',             'UNPRODUCTIVE', 15, 'Sosyal medya'),
  ('domain', 'twitter.com',       'UNPRODUCTIVE', 15, 'Sosyal medya'),
  ('domain', 'tiktok.com',        'UNPRODUCTIVE', 10, 'Video'),
  ('domain', 'twitch.tv',         'UNPRODUCTIVE', 10, 'Yayin'),
  ('domain', 'netflix.com',       'UNPRODUCTIVE', 10, 'Video'),
  ('domain', 'reddit.com',        'UNPRODUCTIVE', 30, 'Forum')
ON CONFLICT DO NOTHING;

COMMIT;
