"""
Mesai oturumu (session) durum makinesi.

    IDLE ──start()──> ACTIVE ──stop()──> IDLE
                        │
                        └── calisma boyunca ornekler `buffer`'a yazilir

Sunucu tarafi otoritedir: agent yalnizca ornek uretir, sureler backend'de
activity_logs uzerinden yeniden hesaplanir.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .api_client import ApiClient, ApiError, RetryableApiError
from .buffer import Buffer

LOG = logging.getLogger(__name__)


@dataclass
class SessionInfo:
    session_id: str
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    started_at: Optional[datetime] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "started_at": self.started_at.isoformat() if self.started_at else None,
        }


class SessionManager:
    def __init__(self, client: ApiClient, buffer: Buffer) -> None:
        self.client = client
        self.buffer = buffer
        self.info: Optional[SessionInfo] = None
        # Sunucu tarafindan gelen son oturum toplamlari
        self.server_totals: Dict[str, Any] = {}

    # ------------------------------------------------------------------ durum
    @property
    def is_active(self) -> bool:
        return self.info is not None

    @property
    def session_id(self) -> Optional[str]:
        return self.info.session_id if self.info else None

    @property
    def project_id(self) -> Optional[str]:
        return self.info.project_id if self.info else None

    @property
    def task_id(self) -> Optional[str]:
        return self.info.task_id if self.info else None

    # ------------------------------------------------------------- baslat/dur
    def start(
        self, project_id: Optional[str] = None, task_id: Optional[str] = None
    ) -> Optional[SessionInfo]:
        if self.info is not None:
            LOG.debug("Oturum zaten aktif: %s", self.info.session_id)
            return self.info
        payload: Dict[str, Any] = {"projectId": project_id, "taskId": task_id}
        try:
            response = self.client.start_session(project_id, task_id)
        except RetryableApiError as exc:
            LOG.warning("Oturum baslatilamadi (cevrimdisi): %s", exc)
            return None
        except ApiError as exc:
            LOG.error("Oturum baslatma hatasi: %s", exc)
            return None

        session = response.get("session") or {}
        session_id = session.get("id")
        if not session_id:
            LOG.error("Sunucu oturum id'si dondurmedi: %s", payload)
            return None

        self.info = SessionInfo(
            session_id=str(session_id),
            project_id=session.get("projectId"),
            task_id=session.get("taskId"),
            started_at=_parse_dt(session.get("startTime")) or datetime.now(timezone.utc),
        )
        self.buffer.set_meta("active_session", _json(self.info.as_dict()))
        LOG.info(
            "Mesai basladi: session=%s proje=%s gorev=%s",
            self.info.session_id,
            self.info.project_id,
            self.info.task_id,
        )
        return self.info

    def stop(self, reason: str = "user") -> Optional[Dict[str, Any]]:
        self.flush_meta()
        if self.info is None:
            LOG.debug("Durdurulacak aktif oturum yok (%s)", reason)
            return None
        session_id = self.info.session_id
        summary: Optional[Dict[str, Any]] = None
        try:
            response = self.client.stop_session(session_id)
            summary = response.get("session")
            LOG.info(
                "Mesai durduruldu: session=%s toplam=%ss bosluk=%ss sebep=%s",
                session_id,
                (summary or {}).get("totalDuration"),
                (summary or {}).get("idleDuration"),
                reason,
            )
        except RetryableApiError as exc:
            LOG.warning("Sunucuya ulasilamadi, oturum kapatma kuyrukta bekleyecek: %s", exc)
            self.buffer.set_meta("pending_stop_session", session_id)
        except ApiError as exc:
            LOG.error("Oturum kapatma hatasi: %s", exc)

        self.info = None
        self.buffer.set_meta("active_session", "")
        return summary

    def adopt_existing(self) -> Optional[SessionInfo]:
        """
        Agent yeniden basladiginda sunucudaki aktif oturumu devralir.
        (Ornek: cihaz yeniden baslatildi, servis tekrar ayaga kalkti.)
        """
        try:
            response = self.client.get("/api/sessions/current")
        except (ApiError, RetryableApiError) as exc:
            LOG.debug("Aktif oturum sorgulanamadi: %s", exc)
            return None
        session = response.get("session")
        if not session:
            return None
        self.info = SessionInfo(
            session_id=str(session["id"]),
            project_id=session.get("projectId"),
            task_id=session.get("taskId"),
            started_at=_parse_dt(session.get("startTime")) or datetime.now(timezone.utc),
        )
        self.buffer.set_meta("active_session", _json(self.info.as_dict()))
        LOG.info("Mevcut oturum devralindi: %s", self.info.session_id)
        return self.info

    def update_selection(
        self, project_id: Optional[str], task_id: Optional[str]
    ) -> None:
        """Tepsi menusunden proje/gorev degisikligi: oturum kapatilip yeniden acilir."""
        if self.info is not None:
            self.info.project_id = project_id
            self.info.task_id = task_id
            self.buffer.set_meta("active_session", _json(self.info.as_dict()))

    # --------------------------------------------------------------- ornekleme
    def record(self, sample: Dict[str, Any]) -> bool:
        """
        Orneği yerel kuyruga yazar. Aktif oturum yoksa False doner.
        Idempotenttir: ayni (session, timestamp) iki kez yazilmaz.
        """
        if self.info is None:
            return False
        return self.buffer.enqueue_activity(self.info.session_id, sample)

    def flush_meta(self) -> None:
        """Oturum bilgisini kuyruk meta'sina yazar (crash sonrasi teshis icin)."""
        if self.info is not None:
            self.buffer.set_meta("active_session", _json(self.info.as_dict()))


# --------------------------------------------------------------------- yardim
def _parse_dt(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _json(value: Dict[str, Any]) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)
