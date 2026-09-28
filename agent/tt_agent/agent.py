"""
Agent calisma zamani (runtime).

Orkestrasyon:
    - Girdi sayaclari      : pynput (icerik yok)
    - Aktif pencere        : psutil / AppKit / win32 / xdotool
    - URL                  : tarayici eklentisi -> AX API -> baslik tahmini
    - Ekran goruntusu      : mss (tum monitorler) + Pillow (sikistirma/blur)
    - Kuyruk & esitleme    : SQLite + SyncWorker
    - Arayuz               : pystray (interactive) veya headless (silent)

Tum agir islemler arka plan thread'lerinde; ana thread interactive modda
tepsi dongusune ayrilir.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import AGENT_NAME, __version__
from .api_client import ApiClient, ApiError, RetryableApiError, UnauthorizedError
from .auth import AuthError, AuthManager
from .buffer import Buffer
from .collectors import (
    InputActivityCollector,
    ScreenCaptureService,
    UrlTracker,
    get_active_window,
)
from .collectors.screen_capture import ScreenshotScheduler
from .config import Config
from .logging_setup import setup_logging
from .notifications import COUNT, DISCARD, Notifier
from .session import SessionManager
from .sync import SyncWorker
from .tray import TrayApp, TrayUnavailable

LOG = logging.getLogger(__name__)


class AgentRuntime:
    def __init__(self, config: Config) -> None:
        self.config = config
        config.ensure_dirs()

        setup_logging(config.log_level, log_file=config.log_path, console=(config.mode == "interactive"))
        LOG.info(
            "%s v%s baslatiliyor (mod=%s, sunucu=%s)",
            AGENT_NAME,
            __version__,
            config.mode,
            config.server_url,
        )

        self.buffer = Buffer(config.db_path)
        self.client = ApiClient(
            config.server_url, verify_tls=config.verify_tls, timeout=config.request_timeout
        )
        self.auth = AuthManager(config, self.client)
        self.session = SessionManager(self.client, self.buffer)

        self.inputs = InputActivityCollector(
            count_mouse_move_as_activity=config.count_mouse_move_as_activity
        )
        self.screens = ScreenCaptureService(
            image_format=config.image_format,
            quality=config.image_quality,
            blur_enabled=config.blur_enabled,
            blur_radius=config.blur_radius,
            max_image_width=config.max_image_width,
            monitors_allowlist=config.monitors_allowlist,
        )
        self.urls = UrlTracker(port=config.browser_url_port, enable_ax=config.ax_url_tracking)
        self.notifier = Notifier(enabled=config.notifications)
        self.scheduler = ScreenshotScheduler(
            block_seconds=config.screenshot_block_seconds, jitter=config.screenshot_jitter
        )
        self.sync = SyncWorker(config, self.client, self.auth, self.buffer, self.session)

        self._stop = threading.Event()
        self._loop_thread: Optional[threading.Thread] = None
        self._dialog_thread: Optional[threading.Thread] = None
        self.tray: Optional[TrayApp] = None

        # Ornekleme durumu
        self._next_sample_at = 0.0
        self._last_sample_ts: Optional[datetime] = None
        self._idle_episode = False
        self._idle_dialog_shown = False
        self._distraction_prompted = False
        self._last_window: Dict[str, Any] = {}
        self._projects_cache: List[dict] = []
        self._tasks_cache: List[dict] = []

        # Sunucudan gelen politik degerler
        self.effective_idle_threshold = config.idle_threshold
        self.effective_distraction_threshold = config.distraction_threshold
        self.effective_screenshot_block = config.screenshot_block_seconds

    # ------------------------------------------------------------------ kurulum
    def setup(self) -> None:
        self.inputs.start()
        self.urls.start()
        self.auth.ensure_authenticated()
        self._apply_server_policy()
        self.sync.start()

        if self.config.auto_start_session or self.config.mode == "silent":
            adopted = self.session.adopt_existing()
            if adopted is None:
                self.session.start(self.config.force_project_id, self.config.force_task_id)
        else:
            self.session.adopt_existing()

        self.refresh_catalogs()

    def _apply_server_policy(self) -> None:
        """Esikleri sunucudan alir (tek dogruluk kaynagi backend'dir)."""
        try:
            policy = self.client.policy()
        except (ApiError, RetryableApiError) as exc:
            LOG.debug("Politika alinamadi, yerel degerler kullanilacak: %s", exc)
            return
        self.effective_idle_threshold = int(
            policy.get("idleThresholdSeconds", self.config.idle_threshold)
        )
        self.effective_distraction_threshold = int(
            policy.get("distractionThresholdSeconds", self.config.distraction_threshold)
        )
        self.effective_screenshot_block = int(
            policy.get("screenshotBlockSeconds", self.config.screenshot_block_seconds)
        )
        if self.effective_screenshot_block != self.scheduler.block_seconds:
            self.scheduler = ScreenshotScheduler(
                block_seconds=self.effective_screenshot_block, jitter=self.config.screenshot_jitter
            )
        LOG.info(
            "Sunucu politikasi: idle=%ss distraction=%ss ekran_blok=%ss",
            self.effective_idle_threshold,
            self.effective_distraction_threshold,
            self.effective_screenshot_block,
        )

    def refresh_catalogs(self) -> None:
        """Tepsi menusu icin proje/gorev listelerini tazeler."""
        if self.config.mode == "silent":
            return
        try:
            self._projects_cache = self.client.list_projects()
            self._tasks_cache = self.client.list_tasks(self.session.project_id)
        except (ApiError, RetryableApiError) as exc:
            LOG.debug("Proje/gorev listesi alinamadi: %s", exc)

    # ------------------------------------------------------------- oturum kontrol
    def toggle_session(self) -> None:
        self.inputs.mark_activity()
        if self.session.is_active:
            self.session.stop(reason="tray")
        else:
            self.session.start(
                self.config.force_project_id
                or (self.session.project_id if self.session.info else None),
                self.config.force_task_id,
            )
        self.refresh_catalogs()
        self.notifier.notify(
            "Zaman Takip",
            "Mesai basladi" if self.session.is_active else "Mesai durduruldu",
        )

    def select_project(self, project_id: Optional[str]) -> None:
        self.session.update_selection(project_id, None)
        self._tasks_cache = []
        self.refresh_catalogs()
        if self.session.is_active:
            LOG.info("Proje degistirildi; yeni oturum baslatiliyor")
            self.session.stop(reason="project-change")
            self.session.start(project_id, self.config.force_task_id)

    def select_task(self, task_id: Optional[str]) -> None:
        self.session.update_selection(self.session.project_id, task_id)
        if self.session.is_active:
            LOG.info("Gorev degistirildi; yeni oturum baslatiliyor")
            self.session.stop(reason="task-change")
            self.session.start(self.session.project_id, task_id)

    # -------------------------------------------------------------- ornekleme
    def _build_sample(self, now: datetime) -> Dict[str, Any]:
        previous = self._last_sample_ts or now
        duration = max(1, int((now - previous).total_seconds()))
        snapshot = self.inputs.snapshot()

        window = get_active_window()
        url, domain, source = self.urls.resolve(window.app_name, window.window_title, window.pid)

        idle_seconds = snapshot.idle_seconds
        is_idle = idle_seconds >= self.effective_idle_threshold

        title = window.window_title
        if title and len(title) > self.config.window_poll_max_title_length:
            title = title[: self.config.window_poll_max_title_length]

        self._last_window = {
            "app": window.app_name,
            "title": title,
            "url": url,
            "domain": domain,
            "url_source": source,
        }

        return {
            "timestamp": previous.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "activeApp": window.app_name,
            "windowTitle": title,
            "url": url,
            "domain": domain,
            "monitorIndex": 0,
            "mouseEvents": snapshot.mouse_events,
            "keyboardEvents": snapshot.keyboard_events,
            "mouseDistance": snapshot.mouse_distance,
            "isIdle": is_idle,
            "idleSeconds": int(idle_seconds),
            "durationSeconds": duration,
        }

    def _sample(self) -> None:
        now = datetime.now(timezone.utc)
        if not self.session.is_active:
            self._last_sample_ts = now
            self.inputs.snapshot()  # sayaclari sifirla, birikmesin
            return

        sample = self._build_sample(now)
        self._last_sample_ts = now

        if self.session.record(sample):
            self.sync.wake()

        self._handle_idle_state(sample)

    def _handle_idle_state(self, sample: Dict[str, Any]) -> None:
        is_idle = bool(sample.get("isIdle"))
        idle_seconds = int(sample.get("idleSeconds") or 0)

        if is_idle and not self._idle_episode:
            self._idle_episode = True
            self._idle_dialog_shown = False
            LOG.info("Bosluk tespit edildi (%ss); sure sayaci durduruldu", idle_seconds)
            self.notifier.notify(
                "Zaman Takip",
                "%s dakikadir islem yok. Sure sayaci durduruldu."
                % max(1, idle_seconds // 60),
            )

        elif not is_idle and self._idle_episode:
            self._idle_episode = False
            self._idle_dialog_shown = False
            LOG.info("Kullanici geri dondu; sayac devam ediyor")

        # Bosluk esigi asildiysa "say / sil" diyalogu goster (episode basina bir kez)
        if (
            is_idle
            and self.config.idle_popup
            and self.session.is_active
            and not self._idle_dialog_shown
            and idle_seconds >= self.config.idle_popup_min_seconds
        ):
            self._idle_dialog_shown = True
            self._ask_idle_dialog(idle_seconds)

    def _ask_idle_dialog(self, idle_seconds: int) -> None:
        """Diyalog ayri thread'de acilir; ornekleme bloklanmaz."""
        if self._dialog_thread is not None and self._dialog_thread.is_alive():
            return

        session_id = self.session.session_id
        if not session_id or not self.config.notifications:
            return

        def worker() -> None:
            try:
                decision = self.notifier.ask_idle_decision(idle_seconds)
                self.buffer.enqueue_idle_decision(session_id, decision, idle_seconds)
                self.sync.wake()
                LOG.info(
                    "Idle karari: %s (%ss) -> %s",
                    decision,
                    idle_seconds,
                    "calisilmis sayildi" if decision == COUNT else "silindi",
                )
            except Exception as exc:  # pragma: no cover
                LOG.warning("Idle diyalogu islenemedi: %s", exc)
            finally:
                self._dialog_thread = None

        self._dialog_thread = threading.Thread(target=worker, name="tt-idle-dialog", daemon=True)
        self._dialog_thread.start()

    # ---------------------------------------------------------------- heartbeat
    def _heartbeat(self) -> None:
        if not self.session.is_active:
            return
        session_id = self.session.session_id
        if not session_id:
            return

        payload = {
            "sessionId": session_id,
            "status": "idle" if self._idle_episode else "active",
            "idleSeconds": int(self.inputs.idle_seconds()),
            "activeApp": self._last_window.get("app"),
            "windowTitle": self._last_window.get("title"),
            "url": self._last_window.get("url"),
            "projectId": self.session.project_id,
            "taskId": self.session.task_id,
            "agentVersion": __version__,
        }
        try:
            response = self.client.heartbeat(payload)
        except UnauthorizedError:
            self.auth.handle_unauthorized()
            return
        except (ApiError, RetryableApiError) as exc:
            LOG.debug("Heartbeat gonderilemedi: %s", exc)
            return

        self.session.server_totals = response.get("session") or {}
        commands = response.get("commands") or {}

        if commands.get("stopSession"):
            LOG.info("Sunucu oturumu kapatti; yerel takip durduruluyor")
            self.session.info = None
            return

        if commands.get("promptDistraction"):
            self._handle_distraction(response)

    def _handle_distraction(self, response: Dict[str, Any]) -> None:
        if self._distraction_prompted or not self.config.distraction_popup:
            return
        self._distraction_prompted = True
        detail = self._last_window.get("domain") or self._last_window.get("title") or ""

        def worker() -> None:
            try:
                still_working = self.notifier.ask_still_working(str(detail))
                LOG.info("Distraction yaniti: %s", "calisiyor" if still_working else "ara verdi")
            except Exception as exc:  # pragma: no cover
                LOG.debug("Distraction diyalogu gosterilemedi: %s", exc)

        threading.Thread(target=worker, name="tt-distraction", daemon=True).start()

        # Bir sonraki uretken doneme kadar tekrar sormamak icin
        threading.Timer(600, self._reset_distraction_flag).start()

    def _reset_distraction_flag(self) -> None:
        self._distraction_prompted = False

    # ------------------------------------------------------- ekran goruntusu
    def _capture_if_due(self) -> None:
        if not self.config.screenshots_enabled or not self.session.is_active:
            return
        if not self.scheduler.due():
            return
        try:
            frames = self.screens.capture_and_store(self.config.capture_dir)
        except Exception as exc:
            LOG.warning("Ekran goruntusu alinamadi: %s", exc)
        else:
            session_id = self.session.session_id
            if session_id:
                for frame in frames:
                    self.buffer.enqueue_screenshot(
                        session_id=session_id,
                        captured_at=frame["captured_at"].isoformat(timespec="seconds"),
                        file_path=frame["file_path"],
                        content_type=frame["content_type"],
                        monitor_index=frame["monitor_index"],
                        monitor_name=frame["monitor_name"],
                        blur_applied=self.config.blur_enabled,
                    )
                if frames:
                    LOG.info(
                        "%s monitorden ekran goruntusu alindi (blur=%s)",
                        len(frames),
                        self.config.blur_enabled,
                    )
                    self.sync.wake()
        finally:
            self.scheduler.mark_captured()

    # ------------------------------------------------------------------- dongu
    def _loop(self) -> None:
        sample_interval = max(5, self.config.sample_interval)
        heartbeat_interval = max(10, self.config.heartbeat_interval)
        next_sample = time.monotonic()
        next_heartbeat = time.monotonic() + heartbeat_interval

        while not self._stop.is_set():
            now = time.monotonic()
            try:
                if now >= next_sample:
                    self._sample()
                    next_sample = now + sample_interval
                if now >= next_heartbeat:
                    self._heartbeat()
                    next_heartbeat = now + heartbeat_interval
                self._capture_if_due()
            except Exception as exc:  # dongu asla olmemeli
                LOG.exception("Ornekleme dongusunde hata: %s", exc)
            self._stop.wait(1.0)

    def start_loop(self) -> None:
        self._loop_thread = threading.Thread(target=self._loop, name="tt-sampler", daemon=True)
        self._loop_thread.start()

    # ------------------------------------------------------------- calistirma
    def run(self) -> None:
        """Moda gore calisir: interactive -> tepsi, silent -> headless dongu."""
        self.setup()
        self.start_loop()

        if self.config.mode == "silent":
            self.run_silent()
            return

        try:
            self._build_tray()
        except TrayUnavailable as exc:
            LOG.warning("Tepsi kullanilamadi (%s); konsol moduna geciliyor", exc)
            self.config.mode = "silent"
            self.run_silent()
            return

        assert self.tray is not None
        self.notifier.attach_icon(self.tray.icon)
        LOG.info("Tepsi ikonu hazir. Cikis icin menuden 'Cikis' secin.")
        self.notifier.notify("Zaman Takip", "Agent calisiyor")
        try:
            self.tray.run()  # ana thread'i bloklar
        except KeyboardInterrupt:  # pragma: no cover
            LOG.info("Klavye ile durduruldu")
        finally:
            self.shutdown()

    def _build_tray(self) -> None:
        self.tray = TrayApp(
            on_toggle=self.toggle_session,
            is_running=lambda: self.session.is_active,
            status_text=self.status_line,
            projects=lambda: self._projects_cache,
            tasks=lambda: self._tasks_cache,
            selected_project=lambda: self.session.project_id,
            selected_task=lambda: self.session.task_id,
            on_select_project=self.select_project,
            on_select_task=self.select_task,
            dashboard_url=self.config.dashboard_url,
            queue_summary=self.queue_summary,
            on_quit=self.shutdown,
        )

    def run_silent(self) -> None:
        """Servis modu: UI yok, dogrudan loglar; sinyallerle kapanir."""
        LOG.info("Silent mod aktif: arayuz gosterilmiyor, veri surekli loglaniyor")
        try:
            while not self._stop.is_set():
                self._stop.wait(5.0)
        except KeyboardInterrupt:  # pragma: no cover
            pass
        finally:
            self.shutdown()

    def status_line(self) -> str:
        window = self._last_window.get("app") or "-"
        state = "AKTIF" if self.session.is_active else "DURDU"
        if self._idle_episode:
            state = "BOSTA"
        synced = "bagli" if not self.sync.last_error else "cevrimdisi"
        return "%s | %s | %s | kuyruk: %s" % (
            state,
            window,
            synced,
            self.buffer.activity_count(),
        )

    def queue_summary(self) -> str:
        stats = self.buffer.stats()
        return "Kuyruk: %s aktivite, %s gorsel" % (
            stats["activity"],
            stats["screenshots_pending"],
        )

    # ------------------------------------------------------------------ kapanis
    def shutdown(self) -> None:
        if self._stop.is_set():
            return
        LOG.info("Agent kapatiliyor...")
        self._stop.set()
        try:
            self.session.stop(reason="shutdown")
        except Exception as exc:  # pragma: no cover
            LOG.debug("Oturum kapatilamadi: %s", exc)
        self.sync.stop()
        self.sync.join(timeout=10)
        self.inputs.stop()
        self.screens.close()
        self.urls.stop()
        if self.tray is not None:
            self.tray.stop()
        try:
            self.buffer.vacuum()
        except Exception:  # pragma: no cover
            pass
        stats = self.buffer.stats()
        self.buffer.close()
        LOG.info("Agent kapandi. Kalan kuyruk: %s", stats)
