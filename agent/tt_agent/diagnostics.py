"""
`tt-agent --check` tanilama raporu.

Kurulum sonrasi hangi yeteneklerin calistigini ve eksik izinleri gosterir:
pynput, ekran yakalama, aktif pencere, URL kaynagi, bildirim backend'i,
sunucu erisimi ve kuyruk durumu.
"""
from __future__ import annotations

import platform
import socket
import sys
from typing import Any, Dict, List, Tuple

from . import __version__
from .collectors import ScreenCaptureService, get_active_window
from .collectors.url_tracker import UrlTracker
from .config import Config
from .notifications import Notifier


def _line(label: str, ok: bool, detail: str = "") -> Tuple[str, bool, str]:
    return (label, ok, detail)


def run_diagnostics(config: Config, check_server: bool = True) -> int:
    """Rapor yazdirir; kritik sorun varsa 1, aksi halde 0 doner."""
    results: List[Tuple[str, bool, str]] = []

    results.append(_line("Python", sys.version_info[:2] >= (3, 9), platform.python_version()))
    results.append(_line("Platform", True, "%s %s" % (platform.system(), platform.release())))

    # --- girdi sayaclari -------------------------------------------------
    try:
        import pynput  # noqa: F401

        results.append(_line("pynput (klavye/fare sayaci)", True, "yuklu"))
    except Exception as exc:
        results.append(
            _line(
                "pynput (klavye/fare sayaci)",
                False,
                "YOK: %s -> pip install pynput" % exc,
            )
        )

    # --- ekran yakalama --------------------------------------------------
    screens = ScreenCaptureService()
    monitors = screens.monitors()
    if monitors:
        detail = ", ".join(
            "m%s %sx%s" % (m["index"], m["width"], m["height"]) for m in monitors
        )
        results.append(_line("Ekran yakalama (mss)", True, detail))
    else:
        results.append(
            _line("Ekran yakalama (mss)", False, screens.error or "monitor bulunamadi")
        )
    screens.close()

    # --- aktif pencere ---------------------------------------------------
    window = get_active_window()
    results.append(
        _line(
            "Aktif pencere tespiti",
            not window.is_empty,
            "app=%s baslik=%s" % (window.app_name, (window.window_title or "")[:60]),
        )
    )

    # --- url kaynagi -----------------------------------------------------
    tracker = UrlTracker(port=config.browser_url_port, enable_ax=config.ax_url_tracking)
    port_ok = tracker.start()
    tracker.stop()
    results.append(
        _line(
            "Tarayici eklentisi alicisi (127.0.0.1:%s)" % config.browser_url_port,
            port_ok,
            "hazir" if port_ok else "port kullanimda",
        )
    )
    if platform.system() == "Darwin":
        try:
            from ApplicationServices import AXUIElementCreateApplication  # noqa: F401

            results.append(
                _line(
                    "macOS Accessibility API",
                    True,
                    "yuklu (izin gerekir: Sistem Ayarlari > Gizlilik > Erisilebilirlik)",
                )
            )
        except Exception:
            results.append(_line("macOS Accessibility API", False, "pyobjc-ApplicationServices yok"))

    # --- bildirim / diyalog ---------------------------------------------
    notifier = Notifier(enabled=False)
    results.append(
        _line(
            "Diyalog backend'i",
            notifier.dialog_backend != "none",
            notifier.dialog_backend,
        )
    )

    try:
        import pystray  # noqa: F401

        results.append(_line("Tepsi ikonu (pystray)", True, "yuklu"))
    except Exception as exc:
        results.append(_line("Tepsi ikonu (pystray)", False, "YOK: %s" % exc))

    # --- yapilandirma ----------------------------------------------------
    results.append(_line("Calisma modu", True, config.mode))
    results.append(
        _line(
            "Ornekleme",
            True,
            "aktivite=%ss heartbeat=%ss idle=%ss ekran_blok=%ss"
            % (
                config.sample_interval,
                config.heartbeat_interval,
                config.idle_threshold,
                config.screenshot_block_seconds,
            ),
        )
    )
    results.append(
        _line(
            "Gizlilik",
            True,
            "blur=%s format=%s kalite=%s" % (config.blur_enabled, config.image_format, config.image_quality),
        )
    )
    if config.password and not config.api_key:
        results.append(
            _line(
                "Kimlik",
                True,
                "e-posta+parola (%s). Uretimde TT_PASSWORD ortam degiskenini kullanin." % config.email,
            )
        )
    elif config.api_key:
        results.append(_line("Kimlik", True, "agent API anahtari"))
    else:
        results.append(_line("Kimlik", False, "api_key veya email+password tanimlanmali"))

    # --- veri dizini -----------------------------------------------------
    config.ensure_dirs()
    writable = True
    try:
        probe = config.data_dir + "/.probe"
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("ok")
        import os

        os.unlink(probe)
    except OSError:
        writable = False
    results.append(_line("Veri dizini", writable, config.data_dir))

    # --- sunucu ----------------------------------------------------------
    if check_server:
        host, port = _parse_host_port(config.server_url)
        reachable = _tcp_check(host, port)
        results.append(
            _line(
                "Sunucu erisimi (%s)" % config.server_url,
                reachable,
                "TCP %s:%s" % (host, port) + (" acik" if reachable else " kapali"),
            )
        )

    # --- rapor ------------------------------------------------------------
    print("\n=== Zaman Takip Agent - Ortam Tanilama (v%s) ===\n" % __version__)
    critical = False
    for label, ok, detail in results:
        marker = "[OK]  " if ok else "[!!]  "
        print("%s%-42s %s" % (marker, label, detail))
        if not ok and label in (
            "pynput (klavye/fare sayaci)",
            "Ekran yakalama (mss)",
            "Kimlik",
            "Veri dizini",
        ):
            critical = True

    print(
        "\nNotlar:\n"
        "  - macOS'ta pencere basliklari icin 'Ekran Kaydi', URL icin 'Erisilebilirlik' izni gerekir.\n"
        "  - Tarayici URL'leri icin agent/browser-extension eklentisini kurun (en dogru yontem).\n"
        "  - Girdi aktivitesi yalnizca SAYAC olarak toplanir; tus icerigi asla kaydedilmez.\n"
    )
    return 1 if critical else 0


def _parse_host_port(url: str) -> Tuple[str, int]:
    import urllib.parse

    parsed = urllib.parse.urlparse(url if "://" in url else "http://" + url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, int(port)


def _tcp_check(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def capability_summary() -> Dict[str, Any]:
    """Programatik kullanim icin ozet yetenek listesi."""
    summary: Dict[str, Any] = {"python": platform.python_version(), "platform": platform.system()}
    for module in ("pynput", "mss", "PIL", "pystray", "psutil", "yaml"):
        try:
            __import__(module)
            summary[module] = True
        except Exception:
            summary[module] = False
    return summary
