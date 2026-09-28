"""
Kimlik dogrulama.

Iki yol desteklenir:
  1) Agent API anahtari (config.api_key)          -> silent/headless kurulumlar
  2) E-posta + parola ile JWT + yenileme tokeni   -> interactive kurulumlar

Token'lar data_dir/auth.json icinde 0600 izinleriyle saklanir. Macera
gerekirse parola yalnizca ortam degiskeninden (TT_PASSWORD) okunmalidir.
"""
from __future__ import annotations

import json
import logging
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .api_client import ApiClient, ApiError, RetryableApiError, UnauthorizedError
from .config import Config

LOG = logging.getLogger(__name__)

# Token suresi dolmadan bu kadar once yenile
REFRESH_MARGIN_SECONDS = 120


class AuthError(Exception):
    """Kimlik dogrulama yapilamadi; agent baslatilamaz."""


class AuthManager:
    def __init__(self, config: Config, client: ApiClient) -> None:
        self.config = config
        self.client = client
        self.state: Dict[str, Any] = {}
        self._load()

    # ------------------------------------------------------------------ durum
    def _load(self) -> None:
        path = self.config.auth_path
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    self.state = json.load(handle)
            except (ValueError, OSError) as exc:
                LOG.warning("auth.json okunamadi (%s), yeniden giris yapilacak", exc)
                self.state = {}

    def _save(self) -> None:
        path = Path(self.config.auth_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.state, handle, ensure_ascii=False, indent=2)
        # Yalnizca sahibi okuyabilsin (0600)
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, path)

    def clear(self) -> None:
        self.state = {}
        try:
            Path(self.config.auth_path).unlink()
        except OSError:
            pass
        self.client.set_access_token(None)

    # ------------------------------------------------------------ token yasam
    @property
    def access_token(self) -> Optional[str]:
        return self.state.get("access_token")

    @property
    def refresh_token(self) -> Optional[str]:
        return self.state.get("refresh_token")

    @property
    def access_expires_at(self) -> Optional[datetime]:
        raw = self.state.get("expires_at")
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            return None

    def _store_tokens(self, payload: Dict[str, Any]) -> None:
        expires_in = int(payload.get("expiresIn") or 900)
        self.state.update(
            {
                "access_token": payload.get("accessToken"),
                "refresh_token": payload.get("refreshToken"),
                "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat(),
                "user": payload.get("user") or self.state.get("user"),
                "server_url": self.config.server_url,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._save()
        self.client.set_access_token(self.state.get("access_token"))

    @property
    def needs_refresh(self) -> bool:
        expires_at = self.access_expires_at
        if expires_at is None:
            return True
        return datetime.now(timezone.utc) >= (expires_at - timedelta(seconds=REFRESH_MARGIN_SECONDS))

    # -------------------------------------------------------------- kullanici
    @property
    def user(self) -> Dict[str, Any]:
        return dict(self.state.get("user") or {})

    def login_with_password(self) -> None:
        if not self.config.email or not self.config.password:
            raise AuthError(
                "E-posta veya parola eksik. config.yaml'da email tanimlayin ve "
                "TT_PASSWORD ortam degiskenini ayarlayin (veya api_key kullanin)."
            )
        try:
            payload = self.client.login(self.config.email, self.config.password)
        except ApiError as exc:
            raise AuthError("Giris basarisiz: %s" % exc.message) from exc
        self._store_tokens(payload)
        LOG.info("Giris basarili: %s (%s)", self.config.email, self.user.get("name", "?"))

    def refresh_access_token(self) -> bool:
        if not self.refresh_token:
            return False
        try:
            payload = self.client.refresh(self.refresh_token)
        except (UnauthorizedError, ApiError) as exc:
            LOG.warning("Yenileme tokeni gecersiz (%s); yeniden giris gerekli", exc)
            return False
        except RetryableApiError as exc:
            LOG.warning("Sunucuya ulasilamadi, token yenilenemedi: %s", exc)
            return False
        self._store_tokens(payload)
        LOG.debug("Erisim tokeni yenilendi")
        return True

    def ensure_authenticated(self) -> None:
        """Agent baslarken cagrilir: uygun yontemle kimlik dogrulamayi saglar."""
        if self.config.api_key:
            # API anahtari ile JWT gerekmez; dogrulama sunucuda yapilir.
            self.client.set_api_key(self.config.api_key)
            LOG.info("Agent API anahtari ile dogrulama yapiliyor")
            try:
                me = self.client.me()
                self.state["user"] = me.get("user", {})
                LOG.info("API anahtari gecerli: %s", self.state["user"].get("email", "?"))
            except UnauthorizedError as exc:
                raise AuthError("Agent API anahtari gecersiz: %s" % exc.message) from exc
            except RetryableApiError as exc:
                # Cevrimdisi baslangic: kuyruk calismaya devam eder
                LOG.warning("Sunucuya ulasilamadi, cevrimdisi mod: %s", exc)
            return

        if self.access_token and not self.needs_refresh:
            self.client.set_access_token(self.access_token)
            LOG.debug("Kayitli erisim tokeni kullaniliyor")
            return

        if self.access_token and self.needs_refresh and self.refresh_token:
            self.client.set_access_token(self.access_token)
            if self.refresh_access_token():
                return

        self.login_with_password()

    def handle_unauthorized(self) -> bool:
        """
        401 alindiginda cagrilir. Token yenilenebildiyse True doner
        ve istek tekrar denenebilir.
        """
        if self.config.api_key:
            return False
        self.client.set_access_token(None)
        if self.refresh_access_token():
            return True
        try:
            self.login_with_password()
            return True
        except AuthError as exc:
            LOG.error("Yeniden giris yapilamadi: %s", exc)
            return False
