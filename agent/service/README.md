# Agent servis kurulumlari (Silent / Interactive)

Agent iki modda calisir:

| Mod | Kullanim | Baslatma |
| --- | --- | --- |
| `interactive` | Calisanin makinesi, tepsi ikonu + mesai baslat/durdur | Kullanici oturumunda `python -m tt_agent` |
| `silent` | Yonetilen/kiosk makineler, UI istemeyen kurumlar | OS servisi (launchd / systemd / Gorev Zamanlayici) |

Her iki mod da ayni veri akisini uretir: aktivite sayaclari, aktif pencere/URL ve
rastgele zamanli ekran goruntuleri. **Tus icerigi hicbir modda kaydedilmez.**

## Ortak hazirlik

```bash
cd agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Yapilandirma
cp config.example.yaml config.yaml
$EDITOR config.yaml          # server_url + api_key (veya email)

# Ortam dogrulama (izinler, ekran yakalama, sunucu erisimi)
.venv/bin/python -m tt_agent --check
```

Silent mod icin `api_key` kullanilmasi onerilir (yonetim paneli → Ekip → "Anahtar uret").
Alternatif olarak parolayi ortam degiskeni ile verin: `TT_PASSWORD=...`.

## macOS (launchd)

```bash
sudo mkdir -p /opt/timetracker-agent
sudo rsync -a --exclude '.venv' ./ /opt/timetracker-agent/
cd /opt/timetracker-agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

cp service/com.timetracker.agent.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.timetracker.agent.plist
launchctl start com.timetracker.agent
launchctl list | grep timetracker
```

Gerekli izinler (Sistem Ayarlari → Gizlilik ve Guvenlik):
- **Ekran Kaydi**: pencere basliklari + ekran goruntusu
- **Erisilebilirlik**: tarayici adres cubugu (URL) okuma
- **Girdi Izleme**: klavye/fare SAYACLARI (icerik degil)

## Linux (systemd)

```bash
sudo mkdir -p /opt/timetracker-agent /etc/timetracker
sudo rsync -a --exclude '.venv' ./ /opt/timetracker-agent/
cd /opt/timetracker-agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

sudo cp service/timetracker-agent.service /etc/systemd/system/
sudo install -m 600 /dev/null /etc/timetracker/agent.env
echo 'TT_PASSWORD=GUCLU_PAROLA' | sudo tee -a /etc/timetracker/agent.env
echo 'DISPLAY=:0'                | sudo tee -a /etc/timetracker/agent.env

sudo systemctl daemon-reload
sudo systemctl enable --now timetracker-agent
journalctl -u timetracker-agent -f
```

## Windows (Gorev Zamanlayici)

```powershell
cd C:\tt-agent
py -3 -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

powershell -ExecutionPolicy Bypass -File .\service\install-windows-task.ps1 `
  -PythonPath "C:\tt-agent\.venv\Scripts\python.exe" `
  -AgentPath  "C:\tt-agent"
```

Parolayi kullanmak yerine `config.yaml` icinde `api_key` tanimlamak daha guvenlidir.
Gerçek bir Windows servisi (Session 0) gerekiyorsa NSSM ile "Interactive" modda
kurun; aksi halde Agent oturum acilisinda kullanici baglaminda calisir.

## Kaldirma

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.timetracker.agent.plist
# Linux
sudo systemctl disable --now timetracker-agent
# Windows
Unregister-ScheduledTask -TaskName TimetrackerAgent -Confirm:$false
# Yerel veri (kuyruk + ekran goruntusu onbellegi)
rm -rf ~/.timetracker-agent
```
