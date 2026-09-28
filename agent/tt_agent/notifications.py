"""
Bildirim ve diyalog katmani.

Neden native diyaloglar? macOS'ta hem pystray (Cocoa) hem tkinter ana thread'i
ister; ikisi ayni surecte cakistigi icin popuplar `osascript` ile NATIVE olarak
gosterilir. Windows'ta native MessageBox, Linux'ta notify-send + tkinter
(ayri bir thread'de) kullanilir. Hicbiri yoksa sessizce loglanir (silent mod).
"""
from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import threading
from typing import Callable, List, Optional, Tuple

LOG = logging.getLogger(__name__)
SYSTEM = platform.system()

IDLE_TIMEOUT_SECONDS = 180
DISTRACTION_TIMEOUT_SECONDS = 60

# Diyalog sonucu: sure calisilmis sayilsin mi?
COUNT = "count"
DISCARD = "discard"


class Notifier:
    """Platforma uygun bildirim ve onay diyaloglarini sunar."""

    def __init__(self, enabled: bool = True, app_name: str = "Zaman Takip") -> None:
        self.enabled = enabled
        self.app_name = app_name
        self._icon: Optional[object] = None
        self._dialog_available = self._probe_dialog_backend()

    def attach_icon(self, icon: object) -> None:
        """pystray ikonu varsa baloncuk bildirimleri icin kullanilir."""
        self._icon = icon

    # ------------------------------------------------------------- yetenekler
    def _probe_dialog_backend(self) -> str:
        if SYSTEM == "Darwin" and shutil.which("osascript"):
            return "osascript"
        if SYSTEM == "Windows":
            return "win32"
        try:
            import tkinter  # noqa: F401

            return "tkinter"
        except Exception:
            return "none"

    @property
    def dialog_backend(self) -> str:
        return self._dialog_available

    # --------------------------------------------------------------- bildirim
    def notify(self, title: str, message: str) -> None:
        if not self.enabled:
            return
        if self._icon is not None:
            try:
                self._icon.notify(message, title)  # type: ignore[attr-defined]
                return
            except Exception:
                pass
        try:
            if SYSTEM == "Darwin":
                self._osascript(
                    'display notification "%s" with title "%s"'
                    % (_escape(message), _escape(title))
                )
            elif SYSTEM == "Windows":
                self._windows_notify(title, message)
            elif shutil.which("notify-send"):
                subprocess.run(
                    ["notify-send", title, message],
                    timeout=5,
                    check=False,
                    capture_output=True,
                )
            else:
                LOG.info("Bildirim: %s - %s", title, message)
        except Exception as exc:  # pragma: no cover
            LOG.debug("Bildirim gonderilemedi: %s", exc)

    # ---------------------------------------------------- idle karar diyalogu
    def ask_idle_decision(self, idle_seconds: int) -> str:
        """
        "Bu sureyi calisilmis say / sil" diyalogu.
        Zaman asimi veya hata durumunda varsayilan: sure sayilmaz (DISCARD),
        cunku bosluk zaten tespit edilmistir ve kullanici onaylamadi.
        """
        minutes = max(1, int(round(idle_seconds / 60.0)))
        title = "%s - Bosluk Tespit Edildi" % self.app_name
        message = (
            "%s dakikadir bilgisayarda islem yapilmadi.\n"
            "Bu sureyi mesaiye dahil etmek ister misiniz?" % minutes
        )
        if not self.enabled:
            return DISCARD

        if self._dialog_available == "osascript":
            script = (
                'display dialog "%s" with title "%s" '
                'buttons {"Calisilmis say", "Sil"} default button 1 cancel button 2 '
                "with icon caution giving up after %s"
                % (_escape(message), _escape(title), IDLE_TIMEOUT_SECONDS)
            )
            output = self._osascript(script)
            if "button returned:Calisilmis say" in output:
                return COUNT
            if "gave up:true" in output:
                LOG.info("Idle diyalogu zaman asimina ugradi; sure sayilmadi")
            return DISCARD

        if self._dialog_available == "win32":
            # MessageBoxW: Yes/No
            choice = self._windows_message_box(
                title,
                message + "\n\nEvet = calisilmis say, Hayir = sil",
            )
            return COUNT if choice else DISCARD

        if self._dialog_available == "tkinter":
            choice = self._tk_dialog(
                title,
                message,
                [("Calisilmis say", COUNT), ("Sil", DISCARD)],
                timeout=IDLE_TIMEOUT_SECONDS,
            )
            return choice or DISCARD

        LOG.info("Idle diyalogu gosterilemiyor (arayuz yok); kayit: %s sn", idle_seconds)
        return DISCARD

    # --------------------------------------------------- distraction diyalogu
    def ask_still_working(self, detail: Optional[str] = None) -> bool:
        """Uretken olmayan icerikte uzun kalma uyarisi. True = kullanici onayladi."""
        title = "%s - Hala calisiyor musunuz?" % self.app_name
        message = "Son dakikada uretken olmayan bir icerikte vakit geciyor."
        if detail:
            message += "\n%s" % detail
        if not self.enabled:
            return True

        if self._dialog_available == "osascript":
            script = (
                'display dialog "%s" with title "%s" '
                'buttons {"Evet, calisiyorum", "Sadece ara"} default button 1 '
                "with icon note giving up after %s"
                % (_escape(message), _escape(title), DISTRACTION_TIMEOUT_SECONDS)
            )
            output = self._osascript(script)
            return "button returned:Evet, calisiyorum" in output

        if self._dialog_available == "win32":
            return self._windows_message_box(title, message + "\n\nEvet = calisiyorum")

        if self._dialog_available == "tkinter":
            choice = self._tk_dialog(
                title,
                message,
                [("Evet, calisiyorum", "yes"), ("Sadece ara", "no")],
                timeout=DISTRACTION_TIMEOUT_SECONDS,
            )
            return choice == "yes"

        return True

    # ------------------------------------------------------------- backend'ler
    @staticmethod
    def _osascript(script: str) -> str:
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=IDLE_TIMEOUT_SECONDS + 30,
            )
            return (result.stdout or "") + (result.stderr or "")
        except Exception as exc:  # pragma: no cover
            LOG.debug("osascript hatasi: %s", exc)
            return ""

    @staticmethod
    def _windows_notify(title: str, message: str) -> None:
        try:  # pragma: no cover - yalnizca Windows
            script = (
                "[reflection.assembly]::loadwithpartialname('System.Windows.Forms');"
                "[System.Windows.Forms.MessageBox]::Show('%s','%s')"
                % (message.replace("'", "''"), title.replace("'", "''"))
            )
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", script],
                timeout=15,
                check=False,
                capture_output=True,
            )
        except Exception as exc:
            LOG.debug("Windows bildirimi gonderilemedi: %s", exc)

    @staticmethod
    def _windows_message_box(title: str, message: str) -> bool:
        try:  # pragma: no cover - yalnizca Windows
            import ctypes

            MB_YESNO = 0x00000004
            MB_ICONQUESTION = 0x00000020
            MB_TOPMOST = 0x00040000
            IDYES = 6
            result = ctypes.windll.user32.MessageBoxW(
                None, message, title, MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
            )
            return result == IDYES
        except Exception as exc:
            LOG.debug("Windows diyalogu gosterilemedi: %s", exc)
            return False

    def _tk_dialog(
        self,
        title: str,
        message: str,
        options: List[Tuple[str, str]],
        timeout: int = 120,
    ) -> Optional[str]:
        """
        tkinter diyalogu. Kendi thread'inde olusturulur; boylece ana thread
        (pystray) bloklanmaz.
        """
        result: List[Optional[str]] = [None]
        ready = threading.Event()
        done = threading.Event()

        def build() -> None:
            try:  # pragma: no cover - arayuz kodu
                import tkinter as tk
                from tkinter import font as tkfont

                root = tk.Tk()
                root.title(title)
                root.attributes("-topmost", True)
                root.resizable(False, False)

                label = tk.Label(root, text=message, justify="left", padx=24, pady=18)
                label.pack()

                frame = tk.Frame(root)
                frame.pack(pady=(0, 16))

                def choose(value: str) -> None:
                    result[0] = value
                    root.destroy()

                bold = tkfont.Font(weight="bold")
                for index, (text, value) in enumerate(options):
                    button = tk.Button(
                        frame, text=text, width=18, command=lambda v=value: choose(v)
                    )
                    if index == 0:
                        button.configure(font=bold, default="active")
                    button.pack(side="left", padx=6)

                root.after(max(5, timeout) * 1000, root.destroy)
                ready.set()
                root.mainloop()
            except Exception as exc:
                LOG.debug("tkinter diyalogu acilamadi: %s", exc)
                ready.set()
            finally:
                done.set()

        thread = threading.Thread(target=build, name="tt-dialog", daemon=True)
        thread.start()
        ready.wait(timeout=5)
        done.wait(timeout=timeout + 10)
        return result[0]


def _escape(value: str) -> str:
    """AppleScript dizesi icin kacis."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
