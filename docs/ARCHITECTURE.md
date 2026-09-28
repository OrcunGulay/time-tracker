# Mimari ve Tasarim Kararlari

## 1. Veri akisi

```
[Agent]  her 20 sn:  {timestamp, activeApp, windowTitle, url, domain,
                      keyboardEvents, mouseEvents, mouseDistance,
                      isIdle, idleSeconds, durationSeconds}
   │
   ├─ SQLite kuyruk (offline buffer, idempotent)
   │
   ├─ 30 sn'de bir:  POST /api/telemetry/activity   (200'luk batch)
   ├─ 30 sn'de bir:  POST /api/telemetry/heartbeat  (canli durum + komutlar)
   └─ 10 dk'lik blokta rastgele 1 sn:
            POST /api/telemetry/screenshot/presigned-url
            PUT  <presigned>            → S3 / MinIO
            POST /api/telemetry/screenshot/confirm
```

Sunucu tarafinda isleme sirasi (`telemetry.routes.ts`):

1. Oturum sahipligi dogrulanir (`requireSessionForUser`).
2. Her ornek icin uretkenlik motoru kategori atar (`category.service` → `productivity.service`).
3. Batch tek `INSERT ... SELECT unnest(...) ON CONFLICT DO NOTHING` ile yazilir
   (idempotent; offline tekrar gonderimleri mukerrer kayit olusturmaz).
4. `sessions` toplamlari `activity_logs`'tan yeniden hesaplanir (sunucu otoritesi).
5. Idle olaylari ve `prompts` (distraction/forceIdle/stopSession) heartbeat yanitinda dondurulur.

## 2. Veri modeli (PostgreSQL 17)

| Tablo | Amac | Onemli kolonlar |
| --- | --- | --- |
| `users` | Personel, rol, departman, bordro | `hourly_rate`, `currency`, `agent_api_key_hash` |
| `projects` / `tasks` / `project_members` | Is kirilimi | `tasks.is_billable` |
| `sessions` | Mesai oturumu ve toplamlar | `total_duration`, `idle_duration`, `deducted_seconds`, `credited_seconds`, `status` |
| `activity_logs` | Ham aktivite ornekleri | `(session_id, timestamp)` UNIQUE, `duration_seconds`, `category` |
| `screenshots` | Gorsel metadata | `storage_key`, `blur_applied`, `deleted_by_employee`, `deducted_seconds` |
| `idle_events` | Bosluk olaylari ve karari | `decision` (`count` / `discard`) |
| `category_rules` | Uretkenlik etiketleri | `match_type` (app/domain), `pattern`, `department`, `priority` |
| `payroll_runs` | Donmus bordro donemleri | `billable_seconds`, `amount`, `status` |
| `audit_logs` | Denetim izi | `action`, `entity_type`, `metadata` |
| `refresh_tokens` | Yenileme tokenlari | `token_hash` (pepper'li SHA-256), `revoked_at` |

Kritik kisitlar:

- `sessions_single_active_uidx`: bir kullanici icin ayni anda tek `active` oturum
  (coklu cihaz / yaris durumu korumasi).
- `activity_logs_unique_sample (session_id, timestamp)`: offline batch idempotency'si.
- `screenshots_unique_frame (session_id, timestamp, monitor_index)`: ayni karenin
  iki kez yuklenmesini engeller.
- `category_rules_global_uidx`: global kural tekilligi.

## 3. Odenebilir sure modeli

```
payableSeconds = total_duration - idle_duration - deducted_seconds + credited_seconds
```

| Bilesen | Kaynagi | Anlam |
| --- | --- | --- |
| `total_duration` | `activity_logs.duration_seconds` toplami | Takip edilen tum sure |
| `idle_duration` | `is_idle = true` ornekler | Girdi olmayan sure (odenmez) |
| `deducted_seconds` | Ekran goruntusu silme protokolu | Silinen 10 dk'lik blok (odenmez) |
| `credited_seconds` | Idle diyalogunda "calisilmis say" | Bosluk geri eklenir (odenir), `idle_duration`'i asamaz |

Bu ayrim, "say / sil" ve "gorseli sil" ozelliklerinin bordroya **tek yonlu ve
cift sayim yapmadan** yansimasini saglar. Tum hesaplar tek yerde (SQL) tutulur.

## 4. Uretkenlik motoru

```
kural secimi:  proje kurali  >  departman kurali  >  global kural
               (esitlikte kucuk `priority` degeri kazanir)
domain kurali, uygulama kuralindan daha ozgul kabul edilir
  (chrome.exe PRODUCTIVE olsa da youtube.com UNPRODUCTIVE ise domain kazanir)
skor = (uretken + notr * neutral_weight) / toplam * 100
```

Kurallar `category_rules` tablosunda tutulur, `category.service` icinde 60 sn
TTL'li bellek onbellegi ile servis edilir ve kural degisikliklerinde gecersiz kilinir.
Siniflandirma her istekte tek kural okumasi yapar (`classifyMany`).

## 5. Guvenlik

| Konu | Uygulama |
| --- | --- |
| Agent kimligi | `x-agent-key` (SHA-256 hash olarak DB'de) veya JWT |
| Dashboard kimligi | HS256 JWT (15 dk) + opak yenileme tokeni (30 gun, rotasyonlu) |
| Yetkilendirme | `authenticate` + `requireRole` decorator'lari, `scope.ts` ile veri kapsami |
| Sema dogrulama | Her route icin JSON Schema (Fastify) |
| Hiz sinirlama | Global 600/dk; telemetry uc noktalarinda 60-240/dk |
| S3 | Presigned PUT (AES256 SSE), goruntuleme icin presigned GET |
| Denetim | Onay, silme, bordro, kullanici yonetimi `audit_logs`'a yazilir |
| Parolalar | bcrypt (10 round); uretimde varsayilan secret'lar reddedilir |

## 6. Dayaniklilik

- **Agent cevrimdisi**: SQLite (WAL) kuyrugu; `(session_id, timestamp)` unique index
  sayesinde tekrar gonderimler guvenli. Kuyruk boyutu `max_queue_mb` ile sinirlanir.
- **Kapanmis oturuma ait kuyruk**: Sunucu, ornek zaman damgasi oturum araliginin
  icindeyse (±10 dk tolerans) kabul eder; boylece mesai kapandiktan sonra gelen
  veri kaybolmaz.
- **Uzun sure islem**: `SyncWorker` ve toplama dongusu kendi hatalarini yakalar,
  hicbir istisna thread'i oldurmez.
- **Yeniden baslatma**: `adopt_existing()` sunucudaki aktif oturumu devralir.
- **Graceful shutdown**: SIGINT/SIGTERM → oturum kapatilir, kuyruk kapatilmadan
  once son bir bosaltma denenir.

## 7. Olceklendirme notlari

- `activity_logs` buyume: `(user_id, timestamp)` indeksi mevcut; uretimde aylik
  partition (`PARTITION BY RANGE (timestamp)`) ve `pg_partman` onerilir.
- Raporlar tek sorguda agregasyon yapar; `dailyReport` kullanici basina dongu
  icerdigi icin 1000+ kullanici icin `MATERIALIZED VIEW` (gunluk ozet) eklenebilir.
- Ekran goruntusu yuklemesi backend'den gecmedigi icin API yuku sabittir;
  presigned URL uretimi stateless olarak yatay olceklendirilebilir.
- Cok kiracili (SaaS) kullanim icin `organization_id` + PostgreSQL RLS onerilir.

## 8. Test stratejisi

| Katman | Arac | Kapsam |
| --- | --- | --- |
| Saf is mantigi | `node --test` | Kategorizasyon, skor, timeline kovalama, JWT, CSV |
| Agent | `unittest` | Gizlilik sozlesmesi (kaynak analizi), kuyruk, kodlama, URL, oturum |
| Sozlesme | JSON Schema | Route girdileri (yanlis veri 400 ile reddedilir) |
| Derleme | `tsc --noEmit`, `next build` | Tip guvenligi ve uretim derlemesi |
