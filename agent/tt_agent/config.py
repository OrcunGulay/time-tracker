"""
Agent yapilandirmasi.

Oncelik sirasi (son kazanir):
    1. Gomulu varsayilanlar
    2. YAML dosyasi (--config veya ./config.yaml)
    3. Ortam degiskenleri (TT_*)
    4. Komut satiri argumanlari

Python 3.9+ ile uyumludur (yapisal tip birlestirme kullanilmaz).
"""
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List, Optional, Union, get_args, get_origin, get_type_hints

try:  # PyYAML opsiyonel: yoksa yalnizca ortam degiskeni + varsayilanlar kullanilir
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None  # type: ignore

DEFAULT_CONFIG_PATHS = (
    "config.yaml",
    "agent.yaml",
    str(Path.home() / ".config" / "timetracker" / "config.yaml"),
)


@dataclass
class Config:
    """Agent'in tum davranisini belirleyen ayarlar."""

    # ---- Sunucu / kimlik ----
    server_url: str = "https://time-tracker-api-asll.onrender.com"
    # Yontem 1: e-posta + parola ile JWT alir (interactive mod icin uygun)
    email: Optional[str] = None
    password: Optional[str] = None
    # Yontem 2: Yonetim panelinden uretilen agent API anahtari (silent mod icin ideal)
    api_key: Optional[str] = None
    verify_tls: bool = True
    request_timeout: float = 15.0

    # ---- Calisma modu ----
    # "interactive": tepsi ikonu + start/stop + gorev secimi
    # "silent"     : arka plan servisi, UI yok, dogrudan loglar
    mode: str = "interactive"
    auto_start_session: bool = True
    force_project_id: Optional[str] = None
    force_task_id: Optional[str] = None

    # ---- Ornekleme araliklari (saniye) ----
    sample_interval: int = 20          # aktivite ornegi
    heartbeat_interval: int = 30       # canli durum bildirimi
    idle_threshold: int = 180          # bu sure giris olmazsa "bosta"
    sync_interval: int = 30            # kuyruk bosaltma
    window_poll_max_title_length: int = 300
    count_mouse_move_as_activity: bool = True

    # ---- Ekran goruntusu ----
    screenshots_enabled: bool = False
    screenshot_block_seconds: int = 600     # her 10 dk'lik blok
    screenshot_jitter: bool = True          # blok icinde rastgele saniye
    capture_all_monitors: bool = True
    monitors_allowlist: List[int] = field(default_factory=list)  # bos = tumu
    image_format: str = "webp"              # webp | jpeg | png
    image_quality: int = 65
    blur_enabled: bool = False              # gizlilik: bulaniklastirma
    blur_radius: float = 12.0
    max_image_width: int = 1920             # buyuk ekranlarda kucultme
    delete_local_after_upload: bool = True

    # ---- URL seviyesi takip ----
    url_tracking: bool = True
    browser_url_port: int = 17873           # tarayici eklentisi bu portu kullanir
    ax_url_tracking: bool = True            # macOS Accessibility API denemesi

    # ---- Bildirim / popup ----
    notifications: bool = True
    distraction_popup: bool = True
    distraction_threshold: int = 60         # uretken olmayan sitede kesintisiz sure
    idle_popup: bool = True                 # "bu sureyi say / sil" diyalogu
    idle_popup_min_seconds: int = 300       # bu kadar boslugu olan diyalog acar

    # ---- Veri / kuyruk ----
    data_dir: str = str(Path.home() / ".timetracker-agent")
    max_queue_mb: int = 200
    log_level: str = "INFO"

    # ---- Yonetim paneli baglantisi (tepsi menusu icin) ----
    dashboard_url: Optional[str] = None

    def __post_init__(self) -> None:
        self.data_dir = str(Path(os.path.expanduser(self.data_dir)))
        if self.server_url:
            self.server_url = self.server_url.rstrip("/")
        if self.mode not in ("interactive", "silent"):
            raise ValueError("mode 'interactive' veya 'silent' olmali")
        if self.image_format not in ("webp", "jpeg", "png"):
            raise ValueError("image_format webp | jpeg | png olmali")
        if self.idle_threshold < 30:
            raise ValueError("idle_threshold en az 30 saniye olmali")
        if self.sample_interval < 5:
            raise ValueError("sample_interval en az 5 saniye olmali")

    # ------------------------------------------------------------- yardimcilar
    @property
    def db_path(self) -> Path:
        return Path(self.data_dir) / "queue.sqlite"

    @property
    def auth_path(self) -> Path:
        return Path(self.data_dir) / "auth.json"

    @property
    def capture_dir(self) -> Path:
        return Path(self.data_dir) / "captures"

    @property
    def log_path(self) -> Path:
        return Path(self.data_dir) / "agent.log"

    def ensure_dirs(self) -> None:
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        self.capture_dir.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- yukleyiciler

def _resolved_types() -> Dict[str, Any]:
    """Alan tiplerini cozer. `from __future__ import annotations` nedeniyle
    `f.type` bir string olabilir; get_type_hints gercek tipleri dondurur."""
    try:
        return dict(get_type_hints(Config))
    except Exception:  # pragma: no cover - cok eski/beklenmeyen ortamlar
        return {f.name: f.type for f in fields(Config)}


def _coerce(field_name: str, raw: Any, field_type: Any) -> Any:
    """Ortam degiskeninden gelen string degerleri alan tipine cevirir."""
    if isinstance(raw, list) and field_type is not List[int]:
        return raw

    origin = get_origin(field_type)

    # List[int] / list
    if origin is list or field_type is list or field_type is List[int]:
        if isinstance(raw, list):
            return [int(x) for x in raw]
        return [int(x) for x in str(raw).replace(";", ",").split(",") if str(x).strip()]

    # Optional[X] -> Union[X, None]
    if origin is Union:
        if raw is None or str(raw).strip().lower() in ("", "null", "none"):
            return None
        candidates = [arg for arg in get_args(field_type) if arg is not type(None)]
        if candidates:
            return _coerce(field_name, raw, candidates[0])
        return raw

    kind = field_type if isinstance(field_type, type) else None
    if kind is bool:
        return str(raw).strip().lower() in ("1", "true", "yes", "on", "evet")
    if kind is int:
        return _int(raw, field_name)
    if kind is float:
        return _float(raw, field_name)
    if kind is str:
        return str(raw)

    # Cozulemeyen tip: oldugu gibi birak (ileride tip kontrolu yapilir)
    return raw


def _int(raw: Any, field_name: str) -> int:
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("%s icin gecersiz tamsayi: %r" % (field_name, raw)) from exc


def _float(raw: Any, field_name: str) -> float:
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("%s icin gecersiz sayi: %r" % (field_name, raw)) from exc


def _load_yaml(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    if yaml is not None:
        data = yaml.safe_load(text) or {}
    else:  # pragma: no cover - PyYAML kurulu olmadiginda JSON destegi
        import json

        data = json.loads(text) if text.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("Yapilandirma dosyasi bir sozluk (mapping) olmali: %s" % path)
    # Ic ice bolumleri duzlestir (orn. screenshots: { enabled: true })
    flat: Dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(value, dict):
            for sub_key, sub_value in value.items():
                flat["%s_%s" % (key, sub_key)] = sub_value
        else:
            flat[key] = value
    return flat


def _apply_env(flat: Dict[str, Any]) -> Dict[str, Any]:
    """TT_SAMPLE_INTERVAL gibi degiskenleri alan adina esler."""
    result = dict(flat)
    all_fields = {f.name for f in fields(Config)}
    for env_key, env_value in os.environ.items():
        if not env_key.startswith("TT_"):
            continue
        candidate = env_key[3:].lower()
        if candidate in all_fields:
            result[candidate] = env_value
    return result


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tt-agent",
        description="Aktivite & Zaman Takip Desktop Agent",
    )
    parser.add_argument("--config", "-c", help="YAML yapilandirma dosyasi yolu")
    parser.add_argument("--mode", choices=("interactive", "silent"), help="Calisma modu")
    parser.add_argument("--server-url", dest="server_url", help="Backend API adresi")
    parser.add_argument("--email", help="Giris e-postasi (parola: TT_PASSWORD)")
    parser.add_argument("--password", help="Giris parolasi (TT_PASSWORD onerilir)")
    parser.add_argument("--api-key", dest="api_key", help="Agent API anahtari (x-agent-key)")
    parser.add_argument("--project-id", dest="force_project_id", help="Sabit proje id")
    parser.add_argument("--task-id", dest="force_task_id", help="Sabit gorev id")
    parser.add_argument("--no-screenshots", dest="screenshots_enabled", action="store_true", default=None)
    parser.add_argument("--blur", dest="blur_enabled", action="store_true", default=None)
    parser.add_argument("--no-blur", dest="blur_enabled", action="store_false", default=None)
    parser.add_argument("--idle-threshold", dest="idle_threshold", type=int)
    parser.add_argument("--sample-interval", dest="sample_interval", type=int)
    parser.add_argument("--data-dir", dest="data_dir")
    parser.add_argument("--log-level", dest="log_level", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    parser.add_argument("--dashboard-url", dest="dashboard_url")
    parser.add_argument("--check", action="store_true", help="Ortam tanilama raporu yazdir ve cik")
    parser.add_argument("--version", action="store_true", help="Surum bilgisini yazdir")
    return parser


def load_config(argv: Optional[List[str]] = None) -> Config:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    flat: Dict[str, Any] = {}
    config_path = args.config
    if config_path:
        flat.update(_load_yaml(config_path))
    else:
        for candidate in DEFAULT_CONFIG_PATHS:
            if os.path.exists(candidate):
                flat.update(_load_yaml(candidate))
                break

    # Parola ortam degiskeninden de gelebilir (dosyada tutulmasi onerilmez)
    env_password = os.environ.get("TT_PASSWORD")
    if env_password:
        flat["password"] = env_password
    flat = _apply_env(flat)

    # Komut satiri en yuksek oncelik
    for key, value in vars(args).items():
        if key in ("config", "check", "version") or value is None:
            continue
        flat[key] = value

    known = {f.name for f in fields(Config)}
    unknown = set(flat) - known
    if unknown:
        raise ValueError("Bilinmeyen yapilandirma anahtarlari: %s" % ", ".join(sorted(unknown)))

    resolved = _resolved_types()
    typed: Dict[str, Any] = {}
    for f in fields(Config):
        if f.name in flat:
            typed[f.name] = _coerce(f.name, flat[f.name], resolved.get(f.name, f.type))
    return Config(**typed)
