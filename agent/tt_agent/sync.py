"""
Veri esitleme (sync) iscisi.

Arka planda periyodik olarak:
  1) Aktivite orneklerini oturum bazinda gruplayip `POST /api/telemetry/activity` ile yollar
  2) Bekleyen ekran goruntulerini presigned URL ile S3'e yukler ve dogrular
  3) Idle kararlarini sunucuya iletir
  4) Kuyruk boyutunu sinirlar (disk dolarsa en eski kayitlar dusurulur)

Cevrimdisi kalindiginda hicbir veri kaybolmaz; kuyrukta birikir.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .api_client import ApiClient, ApiError, RetryableApiError, UnauthorizedError
from .auth import AuthManager
from .buffer import Buffer
from .config import Config
from .session import SessionManager

LOG = logging.getLogger(__name__)

ACTIVITY_BATCH_SIZE = 200
SCREENSHOT_BATCH_SIZE = 3


class SyncWorker(threading.Thread):
    def __init__(
        self,
        config: Config,
        client: ApiClient,
        auth: AuthManager,
        buffer: Buffer,
        session: SessionManager,
    ) -> None:
        super().__init__(name="sync-worker", daemon=True)
        self.config = config
        self.client = client
        self.auth = auth
        self.buffer = buffer
        self.session = session
        self._stop_event = threading.Event()
        self._wake = threading.Event()
        self.last_error: Optional[str] = None
        self.last_success_at: Optional[datetime] = None
        self.stats: Dict[str, Any] = {"activity_sent": 0, "screenshots_sent": 0, "idle_sent": 0}

    # ------------------------------------------------------------------ yasam
    def stop(self) -> None:
        self._stop_event.set()
        self._wake.set()

    def wake(self) -> None:
        """Kuyruga yeni veri geldiginde hemen bosaltmayi tetikler."""
        self._wake.set()

    def run(self) -> None:  # pragma: no cover - thread dongusu
        interval = max(5, self.config.sync_interval)
        while not self._stop_event.is_set():
            self._wake.wait(timeout=interval)
            self._wake.clear()
            if self._stop_event.is_set():
                break
            try:
                self.run_once()
            except Exception as exc:  # beklenmeyen hatada isci olmesin
                LOG.exception("Sync dongusunde hata: %s", exc)
        # Kapanista son bir bosaltma denemesi
        try:
            self.run_once()
        except Exception:
            pass

    def run_once(self) -> None:
        if not self.client.has_credentials:
            return
        try:
            self.flush_activity()
            self.flush_idle_decisions()
            self.flush_screenshots()
            self.buffer.enforce_size_limit(self.config.max_queue_mb)
            self.last_success_at = datetime.now(timezone.utc)
            self.last_error = None
        except RetryableApiError as exc:
            self.last_error = str(exc)
            LOG.debug("Sunucuya ulasilamadi, kuyruk korunuyor: %s", exc)
        except UnauthorizedError:
            if self.auth.handle_unauthorized():
                LOG.info("Token yenilendi, senkronizasyon tekrar deneniyor")
            else:
                LOG.error("Kimlik dogrulama yenilenemedi; kuyruk korunuyor")

    # -------------------------------------------------------------- aktivite
    def flush_activity(self) -> int:
        rows = self.buffer.next_activity_batch(ACTIVITY_BATCH_SIZE)
        if not rows:
            return 0

        # Bir istek yalnizca tek oturuma ait batch kabul eder -> grupla
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(row["session_id"], []).append(row)

        sent_total = 0
        for session_id, group in grouped.items():
            samples = [item["sample"] for item in group]
            ids = [item["id"] for item in group]
            accepted = self._send_batch(session_id, samples, ids)
            if accepted is None:
                break  # baglanti sorunu: sonraki turda tekrar denenecek
            sent_total += accepted

        if sent_total:
            self.stats["activity_sent"] = self.stats.get("activity_sent", 0) + sent_total
            LOG.debug("Aktivite gonderildi: %s ornek", sent_total)
        return sent_total

    def _send_batch(
        self, session_id: str, samples: List[Dict[str, Any]], ids: List[int]
    ) -> Optional[int]:
        try:
            response = self.client.send_activity(session_id, samples)
        except UnauthorizedError:
            if self.auth.handle_unauthorized():
                try:
                    response = self.client.send_activity(session_id, samples)
                except ApiError as exc:
                    self.buffer.mark_activity_failed(ids, str(exc))
                    return None
            else:
                self.buffer.mark_activity_failed(ids, "yetkisiz")
                return None
        except RetryableApiError as exc:
            # Sunucu gecici olarak ulasilamaz: kayitlar kuyrukta kalir
            self.last_error = str(exc)
            raise
        except ApiError as exc:
            # Kalici hata (orn. oturum kapanmis): kayitlari dusur, birikmesin
            LOG.warning("Aktivite batch'i reddedildi (%s): %s", session_id, exc.message)
            self.buffer.mark_activity_failed(ids, exc.message)
            # Kapanmis oturumun bekleyen kayitlarini temizle
            if "aktif degil" in exc.message.lower():
                removed = self.buffer.drop_activity_for_session(session_id)
                LOG.info("Kapanmis oturumun kuyrugu temizlendi: %s kayit", removed)
            return 0

        accepted = int(response.get("accepted", 0)) if response else 0
        duplicates = int(response.get("duplicates", 0)) if response else 0
        if duplicates:
            LOG.debug("Mukerrer kayit atlandi: %s", duplicates)
        self.buffer.mark_activity_sent(ids)
        return accepted

    # --------------------------------------------------------------- idle
    def flush_idle_decisions(self) -> int:
        rows = self.buffer.pending_idle_decisions()
        if not rows:
            return 0
        sent: List[int] = []
        for row in rows:
            try:
                self.client.send_idle_decision(
                    row["session_id"],
                    row["decision"],
                    int(row["idle_seconds"]),
                    row["event_id"],
                )
                sent.append(row["id"])
            except UnauthorizedError:
                if self.auth.handle_unauthorized():
                    continue
                break
            except RetryableApiError:
                raise
            except ApiError as exc:
                LOG.warning("Idle karari gonderilemedi: %s", exc.message)
                sent.append(row["id"])  # kalici hata: tekrar denemeyi birak
        self.buffer.mark_idle_sent(sent)
        self.stats["idle_sent"] = self.stats.get("idle_sent", 0) + len(sent)
        return len(sent)

    # ------------------------------------------------------- ekran goruntusu
    def flush_screenshots(self) -> int:
        import os

        pending = self.buffer.pending_screenshots(SCREENSHOT_BATCH_SIZE)
        uploaded = 0
        for row in pending:
            row_id = int(row["id"])
            file_path = row["file_path"]
            if not file_path or not os.path.exists(file_path):
                self.buffer.delete_screenshot_row(row_id, remove_file=False)
                continue
            try:
                with open(file_path, "rb") as handle:
                    payload = handle.read()
            except OSError as exc:
                self.buffer.mark_screenshot_failed(row_id, str(exc))
                continue

            try:
                presign = self.client.presign_screenshot(
                    {
                        "sessionId": row["session_id"],
                        "capturedAt": row["captured_at"],
                        "monitorIndex": int(row["monitor_index"]),
                        "monitorName": row["monitor_name"],
                        "contentType": row["content_type"],
                        "sizeBytes": len(payload),
                        "blurApplied": bool(row["blur_applied"]),
                    }
                )
            except RetryableApiError:
                raise
            except ApiError as exc:
                LOG.warning("Presigned URL alinamadi (%s): %s", row["session_id"], exc.message)
                self.buffer.mark_screenshot_failed(row_id, exc.message)
                continue

            try:
                self.client.put_bytes(presign["uploadUrl"], row["content_type"], payload)
            except ApiError as exc:
                self.buffer.mark_screenshot_failed(row_id, str(exc))
                continue

            try:
                self.client.confirm_screenshot(
                    {
                        "screenshotId": presign["screenshotId"],
                        "sizeBytes": len(payload),
                        "width": 0,
                        "height": 0,
                    }
                )
            except (ApiError, RetryableApiError) as exc:
                # Yukleme basarili oldu; dogrulama sonraki turda yeniden denenebilir
                LOG.debug("Ekran goruntusu dogrulamasi geciktir: %s", exc)

            self.buffer.mark_screenshot_uploaded(row_id, presign.get("screenshotId"))
            if self.config.delete_local_after_upload:
                self.buffer.delete_screenshot_row(row_id)
            uploaded += 1

        if uploaded:
            self.stats["screenshots_sent"] = self.stats.get("screenshots_sent", 0) + uploaded
            LOG.debug("%s ekran goruntusu yuklendi", uploaded)
        return uploaded

    # -------------------------------------------------------------- teshis
    def health(self) -> Dict[str, Any]:
        return {
            "online": self.last_error is None,
            "last_error": self.last_error,
            "last_success_at": self.last_success_at.isoformat() if self.last_success_at else None,
            "queue": self.buffer.stats(),
            "sent": self.stats,
        }
