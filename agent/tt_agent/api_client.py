"""
Backend API istemcisi.

Bagimlilik yok: yalnizca standart kutuphane `urllib` kullanilir. Bu sayede
agent, paket kurulumu olmadan da (kisitli kurumsal makinelerde) calisir.

Sunucu tarafindan donebilecek hatalar:
    ApiError            -> kalici hata (4xx). Istek tekrarlanmamali.
    RetryableApiError   -> gecici hata (5xx / ag hatasi). Tekrar denenebilir.
    UnauthorizedError   -> 401: token yenilenmeli.
"""
from __future__ import annotations

import json
import logging
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

LOG = logging.getLogger(__name__)

DEFAULT_USER_AGENT = "timetracker-agent/0.1.0"


class ApiError(Exception):
    """Kalici API hatasi (istek tekrarlanmamali)."""

    def __init__(self, status: int, code: str, message: str, payload: Optional[Dict[str, Any]] = None):
        super().__init__("HTTP %s %s: %s" % (status, code, message))
        self.status = status
        self.code = code
        self.message = message
        self.payload = payload or {}


class RetryableApiError(ApiError):
    """Gecici hata: ag kesintisi, 5xx, 429."""


class UnauthorizedError(ApiError):
    """401 - kimlik dogrulama gecersiz."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        verify_tls: bool = True,
        timeout: float = 15.0,
        max_retries: int = 3,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._access_token: Optional[str] = None
        self._api_key: Optional[str] = None
        if verify_tls:
            self._ssl_context: Optional[ssl.SSLContext] = None
        else:  # pragma: no cover - yalnizca kendinden imzali sertifikalar icin
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            self._ssl_context = context

    # ------------------------------------------------------------------- auth
    def set_access_token(self, token: Optional[str]) -> None:
        self._access_token = token

    def set_api_key(self, api_key: Optional[str]) -> None:
        self._api_key = api_key

    @property
    def has_credentials(self) -> bool:
        return bool(self._access_token or self._api_key)

    def _auth_headers(self) -> Dict[str, str]:
        if self._access_token:
            return {"Authorization": "Bearer %s" % self._access_token}
        if self._api_key:
            return {"x-agent-key": self._api_key}
        return {}

    # ---------------------------------------------------------------- istekler
    def request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        raw_body: Optional[bytes] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        absolute_url: Optional[str] = None,
        expected_status: Tuple[int, ...] = (200, 201, 202, 204),
        retries: Optional[int] = None,
    ) -> Any:
        url = absolute_url or ("%s%s" % (self.base_url, path))
        headers = {"User-Agent": DEFAULT_USER_AGENT, "Accept": "application/json"}
        headers.update(self._auth_headers())
        if extra_headers:
            headers.update(extra_headers)

        data: Optional[bytes] = None
        if raw_body is not None:
            data = raw_body
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        attempts = self.max_retries if retries is None else retries
        last_error: Optional[Exception] = None

        for attempt in range(attempts + 1):
            request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
            try:
                with urllib.request.urlopen(
                    request, timeout=self.timeout, context=self._ssl_context
                ) as response:
                    status = response.status
                    payload_bytes = response.read()
                    if status not in expected_status:
                        raise RetryableApiError(status, "UNEXPECTED_STATUS", "Beklenmeyen durum kodu")
                    if not payload_bytes:
                        return None
                    content_type = response.headers.get("Content-Type", "")
                    if "application/json" in content_type:
                        return json.loads(payload_bytes.decode("utf-8"))
                    return payload_bytes
            except urllib.error.HTTPError as error:
                last_error = error
                payload = self._safe_json(error.read())
                code = str(payload.get("error") or "HTTP_%s" % error.code)
                message = str(payload.get("message") or error.reason)
                if error.code == 401 or error.code == 403:
                    raise UnauthorizedError(error.code, code, message, payload) from error
                if error.code == 429 or 500 <= error.code < 600:
                    if attempt < attempts:
                        self._sleep_backoff(attempt)
                        continue
                    raise RetryableApiError(error.code, code, message, payload) from error
                raise ApiError(error.code, code, message, payload) from error
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as error:
                last_error = error
                if attempt < attempts:
                    LOG.debug("Baglanti hatasi, tekrar deneniyor (%s/%s): %s", attempt + 1, attempts, error)
                    self._sleep_backoff(attempt)
                    continue
                raise RetryableApiError(0, "NETWORK_ERROR", str(error)) from error
            except json.JSONDecodeError as error:
                raise RetryableApiError(0, "INVALID_JSON", str(error)) from error

        raise RetryableApiError(0, "UNKNOWN", str(last_error))

    @staticmethod
    def _safe_json(raw: bytes) -> Dict[str, Any]:
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _sleep_backoff(attempt: int) -> None:
        # 1s, 2s, 4s ... + jitter
        import random

        delay = min(30.0, (2 ** attempt) + random.uniform(0, 0.75))
        time.sleep(delay)

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, body: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        return self.request("POST", path, body=body, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Any:
        return self.request("DELETE", path, **kwargs)

    def put_bytes(self, url: str, content_type: str, payload: bytes) -> None:
        """Presigned URL'e ham gorsel yukler (retry yok - URL kisa omurlu)."""
        self.request(
            "PUT",
            "",
            raw_body=payload,
            absolute_url=url,
            extra_headers={"Content-Type": content_type},
            expected_status=(200, 201, 204),
            retries=0,
        )

    # ------------------------------------------------------- yuksek seviye API
    def login(self, email: str, password: str) -> Dict[str, Any]:
        return self.post("/api/auth/login", {"email": email, "password": password})

    def refresh(self, refresh_token: str) -> Dict[str, Any]:
        return self.post("/api/auth/refresh", {"refreshToken": refresh_token})

    def me(self) -> Dict[str, Any]:
        return self.get("/api/auth/me")

    def policy(self) -> Dict[str, Any]:
        return self.get("/api/telemetry/policy")

    def start_session(self, project_id: Optional[str], task_id: Optional[str]) -> Dict[str, Any]:
        return self.post(
            "/api/sessions/start",
            {"projectId": project_id, "taskId": task_id},
        )

    def stop_session(self, session_id: str, ended_at: Optional[str] = None) -> Dict[str, Any]:
        return self.post("/api/sessions/stop", {"sessionId": session_id, "endedAt": ended_at})

    def heartbeat(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.post("/api/telemetry/heartbeat", payload)

    def send_activity(self, session_id: str, batch: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self.post("/api/telemetry/activity", {"sessionId": session_id, "batch": batch})

    def presign_screenshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.post("/api/telemetry/screenshot/presigned-url", payload)

    def confirm_screenshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.post("/api/telemetry/screenshot/confirm", payload)

    def send_idle_decision(
        self, session_id: str, decision: str, idle_seconds: int, event_id: Optional[str] = None
    ) -> Dict[str, Any]:
        return self.post(
            "/api/telemetry/idle-decision",
            {
                "sessionId": session_id,
                "decision": decision,
                "idleSeconds": idle_seconds,
                "idleEventId": event_id,
            },
        )

    def list_projects(self) -> List[Dict[str, Any]]:
        data = self.get("/api/admin/projects")
        return list(data.get("items", []))

    def list_tasks(self, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        path = "/api/admin/tasks"
        if project_id:
            path += "?" + urllib.parse.urlencode({"projectId": project_id})
        data = self.get(path)
        return list(data.get("items", []))
