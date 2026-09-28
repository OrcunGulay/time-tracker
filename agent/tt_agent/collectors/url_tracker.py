"""
URL seviyesinde web takibi.

Uc kaynak, guvenilirlik sirasina gore:
  1) Tarayici eklentisi  : chrome.runtime ile aktif sekme URL'i 127.0.0.1'e POST edilir
                           (en dogru yontem; izin gerektirmez, tum tarayicilarda calisir)
  2) macOS Accessibility : AXUIElement ile adres alani okunur (ek "Erisilebilirlik" izni)
  3) Pencere basligi     : "Baslik - Site Adi - Google Chrome" kalibindan domain cikarimi

Bu modul yalnizca GORUNTULENEN adresi toplar; sayfa icerigi, form verisi veya
tarayici gecmisi okunmaz.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

LOG = logging.getLogger(__name__)

# Pencere basligindaki site adindan domain tahmini (son care)
TITLE_SITE_MAP: Dict[str, str] = {
    "youtube": "youtube.com",
    "github": "github.com",
    "stack overflow": "stackoverflow.com",
    "gitlab": "gitlab.com",
    "jira": "atlassian.net",
    "confluence": "atlassian.net",
    "figma": "figma.com",
    "notion": "notion.so",
    "slack": "slack.com",
    "linkedin": "linkedin.com",
    "instagram": "instagram.com",
    "facebook": "facebook.com",
    "reddit": "reddit.com",
    "x.com": "x.com",
    "twitter": "x.com",
    "netflix": "netflix.com",
    "twitch": "twitch.tv",
    "google docs": "docs.google.com",
    "gmail": "mail.google.com",
    "trello": "trello.com",
    "linear": "linear.app",
    "chatgpt": "chatgpt.com",
    "claude": "claude.ai",
    "npm": "npmjs.com",
    "localhost": "localhost",
}

BROWSER_KEYWORDS = (
    "chrome",
    "chromium",
    "safari",
    "firefox",
    "edge",
    "brave",
    "opera",
    "vivaldi",
    "arc",
    "yandex",
)

DOMAIN_RE = re.compile(r"(?:^|[\s\-–|(])((?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z]{2,24})(?:[/\s)\-–|]|$)", re.I)

EXTENSION_STALE_SECONDS = 30.0


def extract_domain(url: Optional[str]) -> Optional[str]:
    """'https://www.youtube.com/watch?v=1' -> 'youtube.com'"""
    if not url:
        return None
    candidate = url.strip()
    if not candidate:
        return None
    if not re.match(r"^[a-z][a-z0-9+.\-]*://", candidate, re.I):
        embedded = DOMAIN_RE.search(candidate)
        if not embedded:
            return None
        candidate = "https://" + embedded.group(1)
    try:
        host = urlparse(candidate).hostname or ""
    except ValueError:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


def is_browser_app(app_name: Optional[str]) -> bool:
    if not app_name:
        return False
    lowered = app_name.lower()
    return any(keyword in lowered for keyword in BROWSER_KEYWORDS)


@dataclass
class ReportedUrl:
    url: str
    title: Optional[str]
    browser: Optional[str]
    received_at: float


class _ExtensionHandler(BaseHTTPRequestHandler):
    """Tarayici eklentisinden gelen URL bildirimlerini kabul eder (yalnizca localhost)."""

    server_version = "TimetrackerAgent/0.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        tracker: "UrlTracker" = self.server.tracker  # type: ignore[attr-defined]
        if self.path.rstrip("/") not in ("/v1/url", "/url"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 65536:
                raise ValueError("gecersiz govde boyutu")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            tracker.report_from_extension(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as exc:  # pragma: no cover
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(exc)}).encode("utf-8"))

    def log_message(self, *_args) -> None:  # pragma: no cover - gurultuyu engelle
        return


class UrlTracker:
    """
    Aktif tarayici URL'ini belirler.

    `start()` localhost HTTP alicisini baslatir; eklenti kurulu degilse
    diger yontemler devreye girer.
    """

    def __init__(self, port: int = 17873, enable_ax: bool = True) -> None:
        self.port = port
        self.enable_ax = enable_ax
        self._reported: Dict[str, ReportedUrl] = {}
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._ax_available: Optional[bool] = None

    # ------------------------------------------------------------------ yasam
    def start(self) -> bool:
        if self._server is not None:
            return True
        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", self.port), _ExtensionHandler)
            self._server.tracker = self  # type: ignore[attr-defined]
            self._server.daemon_threads = True
            self._thread = threading.Thread(
                target=self._server.serve_forever, name="url-receiver", daemon=True
            )
            self._thread.start()
            LOG.info("Tarayici eklentisi alicisi hazir: http://127.0.0.1:%s/v1/url", self.port)
            return True
        except OSError as exc:
            LOG.warning(
                "URL alicisi baslatilamadi (port %s kullanimda olabilir): %s", self.port, exc
            )
            self._server = None
            return False

    def stop(self) -> None:
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:  # pragma: no cover
                pass
            self._server = None

    # --------------------------------------------------------------- eklenti
    def report_from_extension(self, payload: dict) -> None:
        url = str(payload.get("url") or "").strip()
        if not url or not re.match(r"^[a-z][a-z0-9+.\-]*://", url, re.I):
            raise ValueError("gecersiz url")
        browser = str(payload.get("browser") or "unknown").lower()
        with self._lock:
            self._reported[browser] = ReportedUrl(
                url=url,
                title=payload.get("title"),
                browser=browser,
                received_at=time.monotonic(),
            )

    def reported_url(self, browser_hint: Optional[str] = None) -> Optional[ReportedUrl]:
        """Son N saniye icinde bildirilen URL'i doner."""
        now = time.monotonic()
        with self._lock:
            candidates = [
                item
                for item in self._reported.values()
                if now - item.received_at <= EXTENSION_STALE_SECONDS
            ]
        if not candidates:
            return None
        if browser_hint:
            hint = browser_hint.lower()
            for item in candidates:
                if item.browser and item.browser in hint:
                    return item
        return max(candidates, key=lambda item: item.received_at)

    # ------------------------------------------------------- macOS AX API
    def _ax_url(self, pid: Optional[int]) -> Optional[str]:
        if not self.enable_ax or pid is None:
            return None
        try:
            from ApplicationServices import (  # type: ignore
                AXUIElementCopyAttributeValue,
                AXUIElementCreateApplication,
            )
        except Exception:
            if self._ax_available is None:
                self._ax_available = False
                LOG.debug("Accessibility API yok; URL tespiti eklenti/baslik ile yapilacak")
            return None

        def attr(element, name):
            try:
                error, value = AXUIElementCopyAttributeValue(element, name, None)
                return value if error == 0 else None
            except Exception:
                return None

        try:
            app_element = AXUIElementCreateApplication(pid)
            window = attr(app_element, "AXFocusedWindow")
            if window is None:
                return None
            # Safari: dogrudan adres alani; Chrome/Chromium: AXWebArea -> AXURL
            for attribute in ("AXDocument", "AXURL"):
                value = attr(window, attribute)
                if isinstance(value, str) and value.startswith(("http://", "https://")):
                    return value
            web_area = attr(app_element, "AXWebArea")
            if web_area is not None:
                value = attr(web_area, "AXURL")
                if isinstance(value, str) and value.startswith(("http://", "https://")):
                    return value
            self._ax_available = True
        except Exception:
            self._ax_available = False
        return None

    # -------------------------------------------------------- baslik tahmini
    @staticmethod
    def domain_from_title(window_title: Optional[str]) -> Optional[str]:
        if not window_title:
            return None
        lowered = window_title.lower()
        # 1) Baslik icinde gecen gercek domain (orn. "localhost:4000 - Chrome")
        match = DOMAIN_RE.search(window_title)
        if match:
            candidate = match.group(1).lower()
            if candidate not in ("com", "net", "org"):
                return candidate[4:] if candidate.startswith("www.") else candidate
        # 2) Bilinen site adlari
        for keyword, domain in TITLE_SITE_MAP.items():
            if keyword in lowered:
                return domain
        return None

    # ------------------------------------------------------------------ API
    def resolve(
        self, app_name: Optional[str], window_title: Optional[str], pid: Optional[int] = None
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """
        (url, domain, source) doner.
        source: extension | accessibility | title | None
        """
        if not is_browser_app(app_name):
            return None, None, None

        reported = self.reported_url(app_name)
        if reported is not None:
            return reported.url, extract_domain(reported.url), "extension"

        ax_url = self._ax_url(pid)
        if ax_url:
            return ax_url, extract_domain(ax_url), "accessibility"

        domain = self.domain_from_title(window_title)
        if domain:
            return None, domain, "title"

        return None, None, None
