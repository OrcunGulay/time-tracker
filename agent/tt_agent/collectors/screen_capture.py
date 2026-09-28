"""
Ekran goruntusu modulu.

Ozellikler:
  - Bagli TUM monitorden ayni zaman damgasinda ayri kare yakalama
  - Yerel bellege sigacak sekilde WebP/JPEG/PNG sikistirma + olcekleme
  - Gizlilik icin yapilandirilabilir bulaniklastirma (blur)
  - Rastgele zamanlama (blok icinde rastgele saniye) -> scheduler'da

Bu modul dosyalari diske yazar; yukleme isini `sync` modulu yapar.
"""
from __future__ import annotations

import io
import logging
import random
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

LOG = logging.getLogger(__name__)

CONTENT_TYPES = {"webp": "image/webp", "jpeg": "image/jpeg", "png": "image/png"}


@dataclass
class CapturedFrame:
    """Tek bir monitorun yakalanmis karesi."""

    monitor_index: int
    monitor_name: Optional[str]
    width: int
    height: int
    content_type: str
    data: bytes
    captured_at: datetime

    @property
    def size_bytes(self) -> int:
        return len(self.data)


class ScreenCaptureService:
    def __init__(
        self,
        image_format: str = "webp",
        quality: int = 65,
        blur_enabled: bool = False,
        blur_radius: float = 12.0,
        max_image_width: int = 1920,
        monitors_allowlist: Optional[List[int]] = None,
    ) -> None:
        self.image_format = image_format
        self.quality = quality
        self.blur_enabled = blur_enabled
        self.blur_radius = blur_radius
        self.max_image_width = max_image_width
        self.monitors_allowlist = list(monitors_allowlist or [])
        self._lock = threading.Lock()
        self._sct: Any = None
        self.available = False
        self.error: Optional[str] = None

    # ------------------------------------------------------------ mss oturumu
    def _ensure_sct(self) -> Any:
        if self._sct is not None:
            return self._sct
        try:
            import mss  # yerel import

            self._sct = mss.mss()
            self.available = True
            return self._sct
        except Exception as exc:
            self.error = str(exc)
            self.available = False
            LOG.warning("Ekran yakalama baslatilamadi (mss): %s", exc)
            return None

    def monitors(self) -> List[Dict[str, Any]]:
        """Bagli monitörleri listeler. index=0 tabanlidir (sanal 'tum ekran' haric)."""
        sct = self._ensure_sct()
        if sct is None:
            return []
        result: List[Dict[str, Any]] = []
        for index, monitor in enumerate(sct.monitors[1:]):  # ilk oge tum ekranlari kapsar
            if self.monitors_allowlist and index not in self.monitors_allowlist:
                continue
            result.append(
                {
                    "index": index,
                    "left": monitor["left"],
                    "top": monitor["top"],
                    "width": monitor["width"],
                    "height": monitor["height"],
                    "name": "Monitor %s" % (index + 1),
                }
            )
        return result

    # ---------------------------------------------------------------- yakalama
    def capture_monitor(self, monitor: Dict[str, Any]) -> Optional[CapturedFrame]:
        sct = self._ensure_sct()
        if sct is None:
            return None
        try:
            with self._lock:  # mss thread-safe degil
                shot = sct.grab(
                    {
                        "left": monitor["left"],
                        "top": monitor["top"],
                        "width": monitor["width"],
                        "height": monitor["height"],
                    }
                )
            from PIL import Image  # yerel import

            image = Image.frombytes("RGB", shot.size, shot.rgb)
            return self._encode(image, monitor)
        except Exception as exc:
            LOG.warning("Monitör %s yakalanamadi: %s", monitor.get("index"), exc)
            return None

    def capture_all(self, captured_at: Optional[datetime] = None) -> List[CapturedFrame]:
        """Tum aktif monitörleri ayni zaman damgasiyla yakalar."""
        moment = captured_at or datetime.now(timezone.utc)
        frames: List[CapturedFrame] = []
        for monitor in self.monitors():
            frame = self.capture_monitor(monitor)
            if frame is not None:
                frame.captured_at = moment
                frames.append(frame)
        return frames

    def capture_and_store(
        self, capture_dir: Path, captured_at: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """
        Yakalar, diske yazar ve kuyruga eklenebilecek metadata listesi doner.
        """
        moment = captured_at or datetime.now(timezone.utc)
        stored: List[Dict[str, Any]] = []
        for frame in self.capture_all(moment):
            path = self.build_path(capture_dir, moment, frame.monitor_index)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "wb") as handle:
                    handle.write(frame.data)
            except OSError as exc:
                LOG.error("Ekran goruntusu yazilamadi (%s): %s", path, exc)
                continue
            stored.append(
                {
                    "monitor_index": frame.monitor_index,
                    "monitor_name": frame.monitor_name,
                    "captured_at": moment,
                    "file_path": str(path),
                    "content_type": frame.content_type,
                    "size_bytes": frame.size_bytes,
                    "width": frame.width,
                    "height": frame.height,
                }
            )
        return stored

    # ------------------------------------------------------------------ kodlama
    def _encode(self, image: Any, monitor: Dict[str, Any]) -> Optional[CapturedFrame]:
        from PIL import Image, ImageFilter

        if self.max_image_width and image.width > self.max_image_width:
            ratio = self.max_image_width / float(image.width)
            image = image.resize(
                (self.max_image_width, max(1, int(image.height * ratio))),
                Image.LANCZOS,
            )

        if self.blur_enabled:
            # Gizlilik: tum kare bulaniklastirilir (metin okunamaz hale gelir)
            image = image.filter(ImageFilter.GaussianBlur(radius=self.blur_radius))

        buffer = io.BytesIO()
        fmt = self.image_format.lower()
        if fmt == "webp":
            image.save(buffer, format="WEBP", quality=self.quality, method=4)
        elif fmt == "jpeg":
            image.save(buffer, format="JPEG", quality=self.quality, optimize=True)
        else:
            image.save(buffer, format="PNG", optimize=True)

        return CapturedFrame(
            monitor_index=int(monitor.get("index", 0)),
            monitor_name=monitor.get("name"),
            width=image.width,
            height=image.height,
            content_type=CONTENT_TYPES.get(fmt, "image/webp"),
            data=buffer.getvalue(),
            captured_at=datetime.now(timezone.utc),
        )

    @staticmethod
    def build_path(capture_dir: Path, captured_at: datetime, monitor_index: int) -> Path:
        day = captured_at.astimezone(timezone.utc).strftime("%Y-%m-%d")
        stamp = captured_at.astimezone(timezone.utc).strftime("%H%M%S")
        return Path(capture_dir) / day / ("%s-m%s" % (stamp, monitor_index))

    def close(self) -> None:
        with self._lock:
            if self._sct is not None:
                try:
                    self._sct.close()
                except Exception:  # pragma: no cover
                    pass
                self._sct = None


class ScreenshotScheduler:
    """
    Rastgele zamanli ekran goruntusu planlayicisi.

    Her `block_seconds` uzunlugundaki blok icinde RASTGELE bir saniyede
    yakalama yapar. Boylece calisan "ne zaman cekilecek?" diye tahmin edemez,
    ancak toplam siklik ongorulebilir kalir (Time Doctor davranisi).
    """

    def __init__(self, block_seconds: int = 600, jitter: bool = True) -> None:
        self.block_seconds = max(30, block_seconds)
        self.jitter = jitter
        self._next_at: Optional[float] = None
        self._rng = random.Random()

    def _plan_from(self, base: float) -> float:
        offset = self._rng.uniform(0, self.block_seconds - 1) if self.jitter else 0.0
        return base + offset

    def start(self, now: Optional[float] = None) -> None:
        current = time.monotonic() if now is None else now
        # Ilk blok icin rastgele bir an sec
        self._next_at = self._plan_from(current)

    def due(self, now: Optional[float] = None) -> bool:
        if self._next_at is None:
            self.start(now)
        current = time.monotonic() if now is None else now
        return current >= (self._next_at or 0)

    def seconds_until_next(self, now: Optional[float] = None) -> float:
        if self._next_at is None:
            self.start(now)
        current = time.monotonic() if now is None else now
        return max(0.0, (self._next_at or 0) - current)

    def mark_captured(self, now: Optional[float] = None) -> None:
        current = time.monotonic() if now is None else now
        self._next_at = self._plan_from(current + self.block_seconds)
