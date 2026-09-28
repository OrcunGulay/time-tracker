# Desktop Agent (Python)

Uzaktan calisan personelin masaustu aktivitesini **minimum kaynak** ile toplayan,
gizlilik odakli bir arka plan uygulamasi.

> **Gizlilik sozlesmesi (degismez):** Bu agent tus icerigini (keylogger) asla
> kaydetmez, saklamaz ve gonderinmez. Yalnizca *sayaclar* toplanir:
> tus vurusu adedi, tik sayisi, fare mesafesi. Bu kural `tests/test_input_activity.py`
> icindeki kaynak-kod analizi testiyle otomatik dogrulanir.

## Ne toplar?

| Veri | Siklik | Detay |
| --- | --- | --- |
| Klavye/fare sayaclari | 20 sn'lik pencere | `keyboardEvents`, `mouseEvents`, `mouseDistance` (piksel) |
| Aktif pencere | 20 sn | Uygulama adi (`code`, `chrome.exe`), pencere basligi |
| Aktif URL / domain | 20 sn | Tarayici eklentisi → macOS AX API → baslik tahmini |
| Bosluk (idle) | 1 sn izleme | 3 dk girdi yoksa "bosta" + diyalog |
| Ekran goruntusu | 10 dk'lik blokta RASTGELE 1 sn | Tum monitorler, WebP sikistirma, opsiyonel blur |

## Moduller

```
tt_agent/
├── config.py            # YAML + TT_* ortam degiskeni + CLI katmanlari, fail-fast dogrulama
├── agent.py             # AgentRuntime: orkestrasyon, ornekleme dongusu, heartbeat
├── session.py           # Mesai durum makinesi (start/stop/adopt)
├── sync.py              # SyncWorker: kuyrugu bosaltan arka plan iscisi
├── buffer.py            # SQLite cevrimdisi kuyruk (idempotent)
├── auth.py              # API anahtari veya JWT + yenileme; 0600 izinli auth.json
├── api_client.py        # urllib tabanli istemci (harici bagimlilik yok)
├── notifications.py     # Native popup/bildirim (osascript / win32 / tkinter)
├── tray.py              # pystray tepsi ikonu + proje/gorev menusu
├── diagnostics.py       # `--check` ortam tanilama raporu
└── collectors/
    ├── input_activity.py   # pynput sayaclari (icerik YOK)
    ├── active_window.py    # Win32 / AppKit+Quartz / xdotool
    ├── url_tracker.py      # Eklenti alicisi + AX API + baslik tahmini
    └── screen_capture.py   # mss coklu monitor + Pillow sikistirma/blur + scheduler
```

## Hizli baslangic

```bash
cd agent
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml
export TT_PASSWORD="Ada123!"          # veya config.yaml icinde api_key kullanin
.venv/bin/python -m tt_agent --check   # izinleri ve yetenekleri dogrula
.venv/bin/python -m tt_agent           # interactive mod (tepsi ikonu)
```

Silent (servis) modu:

```bash
.venv/bin/python -m tt_agent --mode silent --api-key tt_xxxxxxxx
```

Servis kurulumlari (launchd / systemd / Windows): [`service/README.md`](service/README.md).

## Cevrimdisi (offline) davranis

1. Ornekler `~/.timetracker-agent/queue.sqlite` icinde birikir (WAL, idempotent unique index).
2. Baglanti geldiginde `SyncWorker` 200'luk batch'ler halinde gonderir.
3. Ekran goruntuleri once presigned URL ile S3'e, sonra metadata API'ye gider;
   basarili yuklemeden sonra yerel dosya silinir.
4. Kuyruk `max_queue_mb` sinirini asarsa en eski aktivite kayitlari dusurulur.

## Bosluk ve dikkat daginikligi

- **Idle**: 3 dakika girdi yoksa ornekler `isIdle=true` olarak isaretlenir, oturum
  suresi sayilmaz. 5 dakikayi asan boslukta "Calisilmis say / Sil" diyalogu acilir;
  karar kuyruga yazilir ve sunucuya iletilir ("say" secilirse sure geri eklenir).
- **Distraction**: Sunucu, uretken olmayan domainde 60 sn'den fazla kalindigini
  tespit ederse heartbeat yanitinda `promptDistraction=true` doner ve agent
  "Hala calisiyor musunuz?" uyarisini gosterir. Kural seti backend'den yonetilir.

## Tarayici eklentisi (URL takibi)

`browser-extension/` klasorundeki MV3 eklentisi aktif sekmenin URL'ini
`http://127.0.0.1:17873/v1/url` adresine bildirir. Eklenti kurulu degilse agent
once macOS Accessibility API'yi, olmazsa pencere basligi sezgisini kullanir.

```text
chrome://extensions → Gelistirici modu → "Paketlenmemis oge yukle" → agent/browser-extension
```

## Testler

```bash
python3 -m unittest discover -s tests -t .
```

Kapsam: yapilandirma katmanlari, offline kuyruk idempotency'si, gizlilik sozlesmesi
(kaynak kod analizi), ekran goruntusu kodlama/blur/olcekleme, URL toplama
(eklenti alicisi dahil) ve oturum durum makinesi.
