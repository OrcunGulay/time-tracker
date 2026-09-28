# Zaman Takip Platformu (Time Doctor mantığı)

Uzaktan calisan personelin masaustu aktivitesini **guvenli, seffaf ve moduler** sekilde
izleyen; uretkenlik skoru, bosluk yonetimi, gizlilik protokolu ve bordro ureten
uctan uca platform.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  DESKTOP AGENT (Python)                                                      │
│  • Klavye/fare SAYACLARI (icerik YOK)   • Aktif pencere + URL (eklenti/AX)   │
│  • Coklu monitor ekran goruntusu (blur) • SQLite offline kuyruk + batch sync │
└───────────────┬──────────────────────────────────────────────┬───────────────┘
                │ JWT / Agent API Key                          │ Presigned PUT
                ▼                                              ▼
┌────────────────────────────────────────────┐      ┌─────────────────────────┐
│  BACKEND API (Node 20 + Fastify + TS)      │      │  S3 / MinIO / R2        │
│  auth · sessions · telemetry · reports     │◄────►│  screenshots bucket     │
│  productivity engine · payroll · audit     │      └─────────────────────────┘
└───────────────┬────────────────────────────┘
                │ PostgreSQL 17
                ▼
┌────────────────────────────────────────────┐      ┌─────────────────────────┐
│  DASHBOARD (Next.js 15 + Tailwind)         │      │  BORDER SERVISLERI      │
│  Canli durum · Timeline · Galeri · Bordro  │      │  launchd / systemd      │
└────────────────────────────────────────────┘      └─────────────────────────┘
```

## Bilesenler

| Dizin | Teknoloji | Gorev |
| --- | --- | --- |
| [`agent/`](agent/) | Python 3.9+ (pynput, mss, Pillow, pystray) | Masaustu toplama agent'i (interactive + silent mod) |
| [`backend/`](backend/) | Node 20+, Fastify 5, TypeScript, PostgreSQL 17 | REST API, uretkenlik motoru, bordro, S3 presign |
| [`dashboard/`](dashboard/) | Next.js 15, React 19, Tailwind CSS 3 | Yonetim paneli (canli durum, timeline, galeri, bordro) |
| [`docs/`](docs/) | — | Mimari ve API sozlesmesi |

## Hizli baslangic

```bash
# 1) Bagimliliklar
make install            # backend + dashboard npm paketleri

# 2) S3 uyumlu depolama (MinIO) + bucket
make infra              # docker compose up -d

# 3) Veritabani (yerel PostgreSQL 17)
createdb timetracker
cp backend/.env.example backend/.env    # DATABASE_URL'i kendinize gore duzenleyin
make migrate            # sema + varsayilan kategori kurallari
make seed               # admin + ekip + projeler
make seed-demo          # (opsiyonel) son 3 gun icin gercekci aktivite verisi

# 4) Sunucular
make backend-dev        # http://localhost:4000
make dashboard-dev      # http://localhost:3000  (admin@localhost / Admin123!)

# 5) Desktop agent
make agent-venv
cd agent && cp config.example.yaml config.yaml
export TT_PASSWORD="Ada123!"            # demo calisan parolasi
.venv/bin/python -m tt_agent --check    # izinleri dogrula
.venv/bin/python -m tt_agent            # tepsi ikonu ile baslat
```

Demo hesaplari (`make seed` sonrasi): `admin@localhost / Admin123!`,
`deniz@localhost / Deniz123!` (takim lideri), `ada@localhost / Ada123!` (calisan).

## Ozellik haritasi

| Gereksinim | Nerede |
| --- | --- |
| Girdi aktivitesi (icerik kaydetmeden) | `agent/tt_agent/collectors/input_activity.py` |
| Bosluk tespiti + "say/sil" diyalogu | `agent/.../agent.py`, `backend/src/routes/telemetry.routes.ts` |
| Aktif pencere/uygulama tespiti | `agent/tt_agent/collectors/active_window.py` |
| Rastgele zamanli ekran goruntusu + blur | `agent/tt_agent/collectors/screen_capture.py` |
| Coklu monitor destegi | `ScreenCaptureService.capture_all()` |
| Cevrimdisi kuyruk + batch sync | `agent/tt_agent/buffer.py`, `sync.py` |
| S3 presigned yukleme | `backend/src/services/storage.service.ts` |
| Uretkenlik skoru + kategori kurallari | `backend/src/services/productivity.service.ts` |
| Distraction popup | `backend/src/routes/telemetry.routes.ts` + `agent/.../notifications.py` |
| URL seviyesinde web takibi | `agent/browser-extension/` + `collectors/url_tracker.py` |
| Gizlilik & silme protokolu | `backend/src/routes/screenshots.routes.ts` (DELETE) |
| Interactive / Silent mod | `agent/tt_agent/config.py` + `agent/service/` |
| Bordro + PDF/CSV fatura | `backend/src/services/payroll.service.ts`, `/api/payroll/*` |
| Canli durum / timeline / galeri / grafik | `dashboard/src/app/(dash)/*` |

## Guvenlik ve gizlilik ilkeleri

1. **Tus icerigi asla kaydedilmez.** Klavye dinleyicisi yalnizca bir sayaci artirir;
   bunu dogrulayan kaynak-kod testi mevcuttur (`agent/tests/test_input_activity.py`).
2. **Sunucu otoritesi.** Sureler agent'in bildirimine gore degil, `activity_logs`
   uzerinden sunucuda yeniden hesaplanir.
3. **Silme hakki.** Calisan kendi ekran goruntusunu silebilir; silinen karenin
   10 dakikalik blogu mesai suresinden dusulur ve `audit_logs`'a yazilir.
4. **RBAC.** `admin` tum veriyi, `manager` kendi departmanini, `employee` yalnizca
   kendisini gorur (`backend/src/lib/scope.ts`).
5. **Kimlik.** Dashboard JWT (HS256 + opak yenileme tokeni), agent icin
   `x-agent-key` alternatifi. Yenileme tokenlari pepper'li SHA-256 ile saklanir.
6. **Depolama.** Ekran goruntuleri sunucudan gecmez; kisa omurlu presigned URL ile
   dogrudan S3'e yazilir (SSE-S3), goruntuleme de presigned GET iledir.

## Dokumantasyon

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — veri akisi, sema, tasarim kararlari
- [`docs/API.md`](docs/API.md) — uctan uca API sozlesmesi (ornek istek/yanitlar)
- [`agent/README.md`](agent/README.md) — agent modulleri, modlar, offline davranis
- [`agent/service/README.md`](agent/service/README.md) — servis kurulumu (launchd/systemd/Windows)

## Dogrulama

```bash
make check     # backend + dashboard typecheck, tüm testler, üretim derlemeleri
```

- Backend: 42 birim testi (kategorizasyon, timeline, JWT, CSV, skor)
- Agent: 83 birim testi (gizlilik sozlesmesi, kuyruk, kodlama, URL, oturum)
- Dashboard: 11 route üretim derlemesi + tip kontrolü

## Bilinen sinirlar / sonraki adimlar

- macOS'ta pencere basligi icin "Ekran Kaydi", URL icin "Erisilebilirlik" izni gerekir;
  izin yoksa agent bozulmadan baslik/domain tahminine duser.
- Wayland altinda ekran yakalama portal gerektirebilir (XWayland ile test edilmelidir).
- Faturalandirilabilir PDF'ler temel tablo formatindadir; kurumsal logo/vergi
  bilgileri icin `payrollToPdf` genisletilebilir.
- Cok kiracili (multi-tenant) kullanim icin `organization_id` kolonu ve RLS onerilir.
