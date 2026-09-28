"""
Aktif (on plandaki) pencere tespiti - Windows, macOS ve Linux.

Donen deger: uygulama adi (process), pencere basligi ve pid.
Tum platformlarda basarisizlik durumunda bos bir ActiveWindow doner;
agent calismaya devam eder.
"""
from __future__ import annotations

import logging
import platform
import subprocess
from dataclasses import dataclass
from typing import Optional

LOG = logging.getLogger(__name__)
SYSTEM = platform.system()


@dataclass
class ActiveWindow:
    app_name: Optional[str] = None
    window_title: Optional[str] = None
    pid: Optional[int] = None

    @property
    def is_empty(self) -> bool:
        return not self.app_name and not self.window_title


EMPTY = ActiveWindow()


def _process_name(pid: Optional[int]) -> Optional[str]:
    if not pid:
        return None
    try:
        import psutil

        return psutil.Process(pid).name()
    except Exception:
        return None


# ---------------------------------------------------------------------- macos
def _macos_window() -> ActiveWindow:
    try:
        from AppKit import NSWorkspace  # type: ignore
    except Exception as exc:  # pragma: no cover
        LOG.debug("AppKit yok: %s", exc)
        return _macos_window_quartz()

    try:
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is None:
            return EMPTY
        name = app.localizedName()
        pid = int(app.processIdentifier())
        title = _macos_window_title(pid)
        return ActiveWindow(app_name=name, window_title=title, pid=pid)
    except Exception as exc:  # pragma: no cover
        LOG.debug("macOS pencere bilgisi alinamadi: %s", exc)
        return EMPTY


def _macos_window_title(pid: int) -> Optional[str]:
    """
    Quartz CGWindowList ile pencere basligi.

    Not: macOS 10.15+ uzerinde BASKA uygulamalarin pencere basliklari icin
    "Ekran Kaydi" izni gerekir. Izin yoksa None doner (uygulama adi yeterlidir).
    """
    try:
        from Quartz import (  # type: ignore
            CGWindowListCopyWindowInfo,
            kCGNullWindowID,
            kCGWindowListExcludeDesktopElements,
            kCGWindowListOptionOnScreenOnly,
        )

        options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
        windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) or []
        for window in windows:
            if int(window.get("kCGWindowOwnerPID", -1)) != pid:
                continue
            layer = int(window.get("kCGWindowLayer", 0))
            if layer != 0:
                continue
            title = window.get("kCGWindowName")
            if title:
                return str(title)
        return None
    except Exception:
        return None


def _macos_window_quartz() -> ActiveWindow:
    """AppKit yoksa Quartz ile en on plandaki pencereyi bulur."""
    try:
        from Quartz import (  # type: ignore
            CGWindowListCopyWindowInfo,
            kCGNullWindowID,
            kCGWindowListOptionOnScreenOnly,
        )

        windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) or []
        for window in windows:
            if int(window.get("kCGWindowLayer", 0)) != 0:
                continue
            pid = int(window.get("kCGWindowOwnerPID", 0)) or None
            return ActiveWindow(
                app_name=str(window.get("kCGWindowOwnerName") or "") or _process_name(pid),
                window_title=str(window.get("kCGWindowName") or "") or None,
                pid=pid,
            )
        return EMPTY
    except Exception:
        return EMPTY


def _macos_frontmost_pid() -> Optional[int]:
    try:
        from AppKit import NSWorkspace  # type: ignore

        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        return int(app.processIdentifier()) if app is not None else None
    except Exception:
        return None


# -------------------------------------------------------------------- windows
def _windows_window() -> ActiveWindow:
    try:
        import ctypes
        from ctypes import wintypes  # type: ignore

        user32 = ctypes.windll.user32
        handle = user32.GetForegroundWindow()
        if not handle:
            return EMPTY

        length = user32.GetWindowTextLengthW(handle)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, buffer, length + 1)

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        pid_value = int(pid.value) or None
        return ActiveWindow(
            app_name=_process_name(pid_value),
            window_title=buffer.value or None,
            pid=pid_value,
        )
    except Exception as exc:  # pragma: no cover
        LOG.debug("Windows pencere bilgisi alinamadi: %s", exc)
        return EMPTY


# ---------------------------------------------------------------------- linux
def _linux_window() -> ActiveWindow:
    # 1) xdotool (X11)
    try:
        window_id = subprocess.run(
            ["xdotool", "getactivewindow"],
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout.strip()
        if window_id:
            title = subprocess.run(
                ["xdotool", "getwindowname", window_id],
                capture_output=True,
                text=True,
                timeout=3,
            ).stdout.strip()
            pid_raw = subprocess.run(
                ["xdotool", "getwindowpid", window_id],
                capture_output=True,
                text=True,
                timeout=3,
            ).stdout.strip()
            pid = int(pid_raw) if pid_raw.isdigit() else None
            return ActiveWindow(app_name=_process_name(pid), window_title=title or None, pid=pid)
    except Exception:
        pass

    # 2) wmctrl
    try:
        output = subprocess.run(
            ["wmctrl", "-l", "-p"], capture_output=True, text=True, timeout=3
        ).stdout
        for line in output.splitlines():
            parts = line.split(None, 4)
            if len(parts) >= 5:
                pid = int(parts[2]) if parts[2].isdigit() else None
                return ActiveWindow(app_name=_process_name(pid), window_title=parts[4], pid=pid)
    except Exception:
        pass

    # 3) Wayland / diger: yalnizca process adi tahmini yapilamaz
    return EMPTY


def get_active_window() -> ActiveWindow:
    """Platforma uygun uygulamayi cagirir. Hata durumunda bos deger doner."""
    try:
        if SYSTEM == "Darwin":
            return _macos_window()
        if SYSTEM == "Windows":
            return _windows_window()
        return _linux_window()
    except Exception as exc:  # pragma: no cover
        LOG.warning("Aktif pencere alinamadi: %s", exc)
        return EMPTY


def frontmost_pid() -> Optional[int]:
    """URL tespiti icin on plandaki uygulamanin pid'i."""
    try:
        if SYSTEM == "Darwin":
            return _macos_frontmost_pid()
        window = get_active_window()
        return window.pid
    except Exception:  # pragma: no cover
        return None
