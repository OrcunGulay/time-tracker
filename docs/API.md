# API Sozlesmesi v1

Temel adres: `http://localhost:4000`. Tum govdeler JSON'dur (UTF-8).
Sema dogrulama Fastify tarafindan yapilir; hatali alan **400** ile reddedilir.

## Kimlik dogrulama

| Yontem | Baslik | Kullanim |
| --- | --- | --- |
| Dashboard / interactive agent | `Authorization: Bearer <accessToken>` | 15 dk omurlu JWT |
| Silent agent | `x-agent-key: tt_<hex>` | Yonetim panelinden uretilir, SHA-256 ile saklanir |

Yenileme tokeni **opak** bir dizedir (JWT degildir) ve 30 gun gecerlidir; her
yenilemede rotasyon yapilir (eski token iptal edilir).

## Hata formati

```json
{ "error": "VALIDATION_ERROR", "message": "Istek dogrulanamadi", "details": [{ "path": "/batch/0/timestamp", "message": "must be string" }] }
```

| Kod | Anlam |
| --- | --- |
| 400 `BAD_REQUEST` / `VALIDATION_ERROR` | Gecersiz veri |
| 401 `UNAUTHORIZED` | Token yok/gecersiz |
| 403 `FORBIDDEN` | Rol/kapsam yetersiz |
| 404 `NOT_FOUND` | Kayit yok |
| 409 `CONFLICT` | Tekil kisit ihlali (orn. ayni e-posta) |
| 429 `RATE_LIMITED` | Hiz siniri |
| 503 | Veritabani erisilemez (`/health/db`) |

---

## Saglik

| Uc nokta | Aciklama |
| --- | --- |
| `GET /health` | Surum/ortam bilgisi |
| `GET /health/db` | Veritabani erisim kontrolu |

## `/api/auth`

| Uc nokta | Govde | Yanit |
| --- | --- | --- |
| `POST /login` | `{email, password}` | `{accessToken, refreshToken, expiresIn, user}` |
| `POST /refresh` | `{refreshToken}` | `{accessToken, refreshToken, expiresIn, user}` |
| `POST /logout` | `{refreshToken}` | `{ok:true}` |
| `GET /me` | — | `{user}` |
| `POST /agent-key` | — | `{apiKey, warning}` *(ham anahtar yalnizca bir kez doner)* |
| `DELETE /agent-key` | — | `{ok:true}` |
| `POST /change-password` | `{currentPassword, newPassword}` | `{ok:true}` *(tum yenileme tokenlari iptal edilir)* |

```bash
curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@localhost","password":"Ada123!"}'
```

## `/api/sessions`

| Uc nokta | Govde / Query | Aciklama |
| --- | --- | --- |
| `POST /start` | `{projectId?, taskId?, clientStartedAt?, clientInfo?}` | Yeni oturum; zaten aktif oturum varsa onu doner |
| `POST /stop` | `{sessionId?, endedAt?}` | Toplamlari loglardan hesaplayip kapatir |
| `GET /current` | — | Aktif oturum (yoksa `null`) |
| `GET /` | `userId? projectId? status? from? to? limit? offset?` | Sayfali liste (employee yalnizca kendini gorur) |
| `GET /:id` | — | Oturum + idle olaylari + aktivite ozeti |
| `POST /:id/approve` | `{status: "approved" \| "rejected"}` | admin/manager; bordroya esass saatler |

`SessionDto` alanlari: `totalDuration, idleDuration, deductedSeconds, creditedSeconds,
productiveSeconds, unproductiveSeconds, neutralSeconds, payableSeconds, status`.

## `/api/telemetry` (agent)

| Uc nokta | Govde | Aciklama |
| --- | --- | --- |
| `GET /policy` | — | `idleThresholdSeconds`, `distractionThresholdSeconds`, `screenshotBlockSeconds` |
| `POST /heartbeat` | `{sessionId, status, idleSeconds?, activeApp?, windowTitle?, url?, agentVersion?}` | Canli durum + komutlar |
| `POST /activity` | `{sessionId, batch:[ActivitySample]}` (max 500) | Idempotent toplu log; kategoriyi sunucu atar |
| `POST /screenshot/presigned-url` | `{sessionId, capturedAt, monitorIndex, monitorName?, contentType?, sizeBytes?, blurApplied?}` | `{screenshotId, storageKey, uploadUrl, expiresIn, method, headers}` |
| `POST /screenshot/confirm` | `{screenshotId, sizeBytes?, width?, height?}` | Yukleme dogrulamasi |
| `POST /idle-decision` | `{sessionId, idleEventId?, decision: "count"\|"discard", idleSeconds?}` | Bosluk karari (`count` → sure geri eklenir) |

`ActivitySample`:

```json
{
  "timestamp": "2026-03-10T09:00:20+00:00",
  "activeApp": "chrome.exe",
  "windowTitle": "YouTube - Google Chrome",
  "url": "https://youtube.com/watch?v=abc",
  "domain": "youtube.com",
  "monitorIndex": 0,
  "mouseEvents": 12,
  "keyboardEvents": 34,
  "mouseDistance": 812,
  "isIdle": false,
  "idleSeconds": 0,
  "durationSeconds": 20
}
```

Heartbeat yanitindaki komutlar:

```json
{
  "serverTime": "2026-03-10T09:00:30.000Z",
  "commands": { "promptDistraction": true, "forceIdle": false, "stopSession": false },
  "session": { "id": "…", "totalDuration": 3600, "idleDuration": 120, "status": "active" }
}
```

**Cevrimdisi kuyruk notu:** `POST /activity` durdurulmus bir oturum icin de,
ornek zaman damgalari oturum araliginin icinde (±10 dk tolerans) ise **kabul edilir**.
Boylece mesai kapandiktan sonra bosaltilan kuyruk verisi kaybolmaz.

## `/api/screenshots`

| Uc nokta | Query / Govde | Aciklama |
| --- | --- | --- |
| `GET /` | `userId? sessionId? from? to? monitorIndex? includeDeleted? limit? offset?` | Galeri; her kayit icin taze presigned `url` |
| `GET /:id` | — | Tek kayit |
| `GET /:id/url` | — | Yeni presigned goruntuleme URL'i |
| `DELETE /:id` | — | **Gizlilik protokolu**: yalnizca kaydin sahibi silebilir |

`DELETE` yaniti:

```json
{ "ok": true, "deductedSeconds": 600, "notice": "10 dakikalik blok mesai suresinden dusuldu.",
  "session": { "id": "…", "deductedSeconds": 600, "payableSeconds": 7200 } }
```

Islem `audit_logs`'a `screenshot.delete_by_employee` olarak yazilir; S3 nesnesi silinir.

## `/api/reports`

| Uc nokta | Query | Yanit |
| --- | --- | --- |
| `GET /live` | — | Cevrimici/bosta/cevrimdisi + aktif uygulama, proje/gorev, oturum suresi |
| `GET /daily` | `date=YYYY-MM-DD&userId?&projectId?` | Kullanici bazli gunluk ozet + `productivityScore` |
| `GET /timeline` | `userId?&date=&slotMinutes=5` | `slots[]` (`active\|idle\|unproductive\|deducted\|offline`) + `summary` |
| `GET /usage` | `date=&userId?&groupBy=app\|domain` | Sure + tus/fare sayilari, kategori |
| `GET /productivity` | `from=&to=&userId?` | Genel skor + kullanici kirilimi |

## `/api/admin` (admin / manager)

| Uc nokta | Rol | Aciklama |
| --- | --- | --- |
| `GET /users`, `GET /departments` | admin, manager | Kullanici listesi, departmanlar |
| `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` | admin | Kullanici yonetimi (`hourlyRate` dahil) |
| `GET/POST /projects`, `PATCH /projects/:id` | admin, manager | Proje yonetimi |
| `POST /projects/:id/members` | admin, manager | `{userId, remove?}` |
| `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id` | admin, manager | Gorev yonetimi |
| `GET/POST /categories`, `PATCH/DELETE /categories/:id` | admin, manager | Uretkenlik kurallari |
| `GET /categories/test` | admin, manager | `?app=chrome.exe&url=https://youtube.com` → `{category}` |
| `GET /audit` | admin | Denetim kaydi (aktör, islem, metadata) |

Manager yalnizca kendi departmaninin kategorilerini duzenleyebilir; kategori
degisiklikleri bellek onbellegini (`category.service.invalidateCache`) temizler.

## `/api/payroll`

| Uc nokta | Rol | Query | Aciklama |
| --- | --- | --- | --- |
| `GET /me` | all | `periodStart?&periodEnd?` | Calisanin kendi bordro ozeti |
| `GET /summary` | admin, manager | `periodStart?&periodEnd?&userId?` | Donem dokumu + toplamlar |
| `GET /export` | admin, manager | `...&format=csv\|pdf&title?` | CSV (noktali virgul, BOM) veya PDF fatura |
| `POST /issue` | admin, manager | `{periodStart, periodEnd, userId?}` | Donemi dondurur (`payroll_runs`, status=issued) |
| `GET /runs` | admin, manager | `userId?&from?&to?` | Donmus donemler |
| `POST /runs/:id/pay` | admin, manager | — | `status=paid` + `paid_at` |

Donem parametreleri verilmezse **icinde bulunulan ayin 1'i → bugun** kabul edilir.
`export` cagrilari da denetim kaydina yazilir (`payroll.export.csv|pdf`).

## Ornek: uctan uca oturum

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@localhost","password":"Ada123!"}' | jq -r .accessToken)

# 1) Mesaiyi baslat
SESSION=$(curl -s localhost:4000/api/sessions/start -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' | jq -r .session.id)

# 2) Aktivite gonder
curl -s localhost:4000/api/telemetry/activity -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{
    \"sessionId\": \"$SESSION\",
    \"batch\": [{\"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S+00:00)\",
                \"activeApp\": \"Code\", \"keyboardEvents\": 40,
                \"mouseEvents\": 5, \"mouseDistance\": 300, \"durationSeconds\": 20}]
  }"

# 3) Heartbeat ve oturum kapatma
curl -s localhost:4000/api/telemetry/heartbeat -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"sessionId\":\"$SESSION\",\"status\":\"active\"}"
curl -s localhost:4000/api/sessions/stop -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"sessionId\":\"$SESSION\"}"
```
