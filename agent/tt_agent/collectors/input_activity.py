"""
Girdi aktivitesi toplayici.

!! GIZLILIK SOZLESMESI !!
    Bu modul tus ICERIGINI asla saklamaz, loglamaz veya gonderinmez.
    `on_press` geri cagrisi yalnizca bir sayaci artirir; tusun kendisi
    hicbir degiskene atanmaz. Bu dosyada `str(key)` / `key.char`
    KULLANILMAMALIDIR (bkz. tests/test_input_activity.py gizlilik testi).

Toplanan metrikler:
    - keyboard_events : penceredeki tus vurusu adedi
    - mouse_events    : fare tik sayisi (sol/sag/orta dahil)
    - mouse_distance  : piksel cinsinden toplam fare hareket mesafesi
    - last_input_at   : son girdi zamani (bosluk/idle tespiti icin)
"""
from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

LOG = logging.getLogger(__name__)

# Tek bir harekette sayilacak en buyuk mesafe (piksel). Monitor gecislerinde
# olusan siçramalari gercek hareket saymamak icin ust sinir uygulanir.
MAX_MOVE_DELTA = 3000.0


@dataclass
class InputSnapshot:
    """Iki ornekleme arasi girdi ozeti."""

    keyboard_events: int = 0
    mouse_events: int = 0
    mouse_distance: int = 0
    interval_seconds: float = 0.0
    idle_seconds: float = 0.0

    @property
    def has_input(self) -> bool:
        return self.keyboard_events > 0 or self.mouse_events > 0 or self.mouse_distance > 0

    def as_dict(self) -> dict:
        return {
            "keyboardEvents": self.keyboard_events,
            "mouseEvents": self.mouse_events,
            "mouseDistance": self.mouse_distance,
            "idleSeconds": int(self.idle_seconds),
        }


class InputActivityCollector:
    """
    pynput dinleyicileri ile sayac tutan toplayici.

    pynput yoksa (veya baglanti kurulamazsa) `available` False olur ve
    agent sayaclari sifir olarak raporlar; diger moduller calismaya devam eder.
    """

    def __init__(self, count_mouse_move_as_activity: bool = True) -> None:
        self.count_mouse_move_as_activity = count_mouse_move_as_activity
        self.available = False
        self.error: Optional[str] = None

        self._lock = threading.Lock()
        self._keyboard = 0
        self._mouse_events = 0
        self._mouse_distance = 0.0
        self._last_move: Optional[tuple] = None
        self._last_input_at = time.monotonic()
        self._last_snapshot_at = time.monotonic()
        self._started = False
        self._listeners: list = []

    # ------------------------------------------------------------------ yasam
    def start(self) -> bool:
        if self._started:
            return self.available
        self._started = True
        try:
            from pynput import keyboard, mouse  # yerel import: opsiyonel bagimlilik
        except Exception as exc:  # pragma: no cover - platforma bagli
            self.error = str(exc)
            LOG.warning(
                "pynput yuklenemedi (%s). Girdi aktivitesi sifir olarak raporlanacak.", exc
            )
            return False

        try:
            keyboard_listener = keyboard.Listener(on_press=self._on_key_press)
            mouse_listener = mouse.Listener(
                on_click=self._on_click,
                on_move=self._on_move,
                on_scroll=self._on_scroll,
            )
            # pynput dinleyicileri kendi thread'lerinde calisir
            keyboard_listener.daemon = True
            mouse_listener.daemon = True
            keyboard_listener.start()
            mouse_listener.start()
            self._listeners = [keyboard_listener, mouse_listener]
            self.available = True
            LOG.info("Girdi aktivitesi dinleyicileri basladi (icerik kaydedilmez).")
        except Exception as exc:  # pragma: no cover
            self.error = str(exc)
            LOG.error("Girdi dinleyicileri baslatilamadi: %s", exc)
            self.available = False
        return self.available

    def stop(self) -> None:
        for listener in self._listeners:
            try:
                listener.stop()
            except Exception:  # pragma: no cover
                pass
        self._listeners = []
        self._started = False

    # ------------------------------------------------------------- geri cagri
    def _touch(self) -> None:
        self._last_input_at = time.monotonic()

    def _on_key_press(self, _key: Any) -> None:
        # ONEMLI: `_key` degeri kasitli olarak KULLANILMAZ.
        with self._lock:
            self._keyboard += 1
        self._touch()

    def _on_click(self, _x: int, _y: int, _button: Any, pressed: bool) -> None:
        if not pressed:
            return
        with self._lock:
            self._mouse_events += 1
        self._touch()

    def _on_scroll(self, _x: int, _y: int, _dx: int, _dy: int) -> None:
        with self._lock:
            self._mouse_events += 1
        self._touch()

    def _on_move(self, x: int, y: int) -> None:
        with self._lock:
            previous = self._last_move
            self._last_move = (x, y)
            if previous is not None:
                distance = math.hypot(x - previous[0], y - previous[1])
                if distance <= MAX_MOVE_DELTA:
                    self._mouse_distance += distance
        if self.count_mouse_move_as_activity:
            self._touch()

    # ---------------------------------------------------------------- okuma
    def snapshot(self) -> InputSnapshot:
        """Sayaclari okur ve sifirlar (her ornekleme penceresinde bir kez)."""
        now = time.monotonic()
        with self._lock:
            snapshot = InputSnapshot(
                keyboard_events=self._keyboard,
                mouse_events=self._mouse_events,
                mouse_distance=int(self._mouse_distance),
                interval_seconds=now - self._last_snapshot_at,
                idle_seconds=now - self._last_input_at,
            )
            self._keyboard = 0
            self._mouse_events = 0
            self._mouse_distance = 0.0
            self._last_snapshot_at = now
            self._last_move = None
        return snapshot

    def idle_seconds(self) -> float:
        """Son girdiden bu yana gecen sure (makine uykusundan etkilenmez)."""
        return time.monotonic() - self._last_input_at

    def mark_activity(self) -> None:
        """Disaridan aktivite isaretleme (orn. tepsi menusu kullanimi)."""
        self._touch()
