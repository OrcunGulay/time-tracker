"""
Sistem tepsisi (system tray) - yalnizca `interactive` modda kullanilir.

Menu:
    Durum (canli bilgi)
    Mesaiyi Baslat / Durdur
    Proje secimi (alt menu)
    Gorev secimi (alt menu)
    Kendi ekran goruntulerim  -> dashboard'u tarayicida acar
    Kuyruk durumu
    Cikis

pystray yoksa `TrayUnavailable` firlatilir; agent konsol moduna duser.
"""
from __future__ import annotations

import logging
import threading
import webbrowser
from typing import Any, Callable, List, Optional

LOG = logging.getLogger(__name__)


class TrayUnavailable(RuntimeError):
    pass


def _build_icon_image() -> Any:
    """Harici gorsel dosyasi gerektirmeyen basit tepsi ikonu."""
    from PIL import Image, ImageDraw

    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((4, 4, size - 4, size - 4), fill=(29, 78, 137, 255))
    draw.ellipse((10, 10, size - 10, size - 10), fill=(255, 255, 255, 255))
    # Saat ibreleri
    draw.line((size / 2, size / 2, size / 2, 20), fill=(29, 78, 137, 255), width=4)
    draw.line((size / 2, size / 2, 44, size / 2), fill=(29, 78, 137, 255), width=4)
    return image


class TrayApp:
    """
    Tepsi uygulamasi. `run()` ana thread'de cagrilmalidir (macOS/Windows zorunlulugu).
    """

    def __init__(
        self,
        on_toggle: Callable[[], None],
        is_running: Callable[[], bool],
        status_text: Callable[[], str],
        projects: Callable[[], List[dict]],
        tasks: Callable[[], List[dict]],
        selected_project: Callable[[], Optional[str]],
        selected_task: Callable[[], Optional[str]],
        on_select_project: Callable[[Optional[str]], None],
        on_select_task: Callable[[Optional[str]], None],
        dashboard_url: Optional[str],
        queue_summary: Callable[[], str],
        on_quit: Callable[[], None],
    ) -> None:
        try:
            import pystray  # noqa: F401
        except Exception as exc:  # pragma: no cover - bagimlilik yoksa
            raise TrayUnavailable("pystray yuklu degil: %s" % exc) from exc

        self.pystray = __import__("pystray")
        self.on_toggle = on_toggle
        self.is_running = is_running
        self.status_text = status_text
        self.projects = projects
        self.tasks = tasks
        self.selected_project = selected_project
        self.selected_task = selected_task
        self.on_select_project = on_select_project
        self.on_select_task = on_select_task
        self.dashboard_url = dashboard_url
        self.queue_summary = queue_summary
        self.on_quit = on_quit

        self.icon = self.pystray.Icon(
            "timetracker",
            icon=_build_icon_image(),
            title="Zaman Takip",
            menu=self._build_menu(),
        )

    # ------------------------------------------------------------------ menu
    def _build_menu(self) -> Any:
        Menu = self.pystray.Menu
        MenuItem = self.pystray.MenuItem

        return Menu(
            MenuItem(lambda _item: self.status_text(), None, enabled=False),
            Menu.SEPARATOR,
            MenuItem(
                lambda _item: "Mesaiyi Durdur" if self.is_running() else "Mesaiyi Baslat",
                self._on_toggle,
                default=True,
            ),
            MenuItem("Proje", Menu(lambda: self._project_items())),
            MenuItem("Gorev", Menu(lambda: self._task_items())),
            Menu.SEPARATOR,
            MenuItem(lambda _item: self.queue_summary(), None, enabled=False),
            MenuItem("Kendi ekran goruntulerim", self._open_dashboard),
            MenuItem("Sunucu durumunu kontrol et", self._ping),
            Menu.SEPARATOR,
            MenuItem("Cikis", self._on_quit),
        )

    def _project_items(self) -> List[Any]:
        MenuItem = self.pystray.MenuItem
        current = self.selected_project()
        items = [MenuItem("(Proje yok)", self._make_project_handler(None), checked=lambda _i: current is None, radio=True)]
        for project in self._safe(self.projects):
            project_id = project.get("id")
            label = str(project.get("name") or project_id)
            items.append(
                MenuItem(
                    label,
                    self._make_project_handler(project_id),
                    checked=lambda _i, pid=project_id: current == pid,
                    radio=True,
                )
            )
        return items

    def _task_items(self) -> List[Any]:
        MenuItem = self.pystray.MenuItem
        current = self.selected_task()
        items = [MenuItem("(Gorev yok)", self._make_task_handler(None), checked=lambda _i: current is None, radio=True)]
        for task in self._safe(self.tasks):
            task_id = task.get("id")
            label = str(task.get("title") or task_id)
            items.append(
                MenuItem(
                    label,
                    self._make_task_handler(task_id),
                    checked=lambda _i, tid=task_id: current == tid,
                    radio=True,
                )
            )
        return items

    def _make_project_handler(self, project_id: Optional[str]) -> Callable[[Any], None]:
        def handler(_icon: Any, _item: Any = None) -> None:
            self.on_select_project(project_id)

        return handler

    def _make_task_handler(self, task_id: Optional[str]) -> Callable[[Any], None]:
        def handler(_icon: Any, _item: Any = None) -> None:
            self.on_select_task(task_id)

        return handler

    @staticmethod
    def _safe(loader: Callable[[], List[dict]]) -> List[dict]:
        try:
            return loader() or []
        except Exception as exc:  # pragma: no cover
            LOG.debug("Menu verisi alinamadi: %s", exc)
            return []

    # -------------------------------------------------------------- eylemler
    def _on_toggle(self, _icon: Any = None, _item: Any = None) -> None:
        try:
            self.on_toggle()
        except Exception as exc:  # pragma: no cover
            LOG.error("Tepsi eylemi basarisiz: %s", exc)
        self.refresh()

    def _open_dashboard(self, _icon: Any = None, _item: Any = None) -> None:
        if not self.dashboard_url:
            self.notify("Panel adresi tanimli degil", "config.yaml -> dashboard_url")
            return
        try:
            webbrowser.open(self.dashboard_url)
        except Exception as exc:  # pragma: no cover
            LOG.debug("Panel acilamadi: %s", exc)

    def _ping(self, _icon: Any = None, _item: Any = None) -> None:
        self.notify("Durum", self.status_text())

    def _on_quit(self, _icon: Any = None, _item: Any = None) -> None:
        try:
            self.on_quit()
        finally:
            self.icon.stop()

    # ------------------------------------------------------------- yardimci
    def notify(self, title: str, message: str) -> None:
        try:
            self.icon.notify(message, title)
        except Exception:  # pragma: no cover
            LOG.info("%s: %s", title, message)

    def refresh(self) -> None:
        try:
            self.icon.update_menu()
        except Exception:  # pragma: no cover
            pass

    def set_title(self, text: str) -> None:
        try:
            self.icon.title = text
        except Exception:  # pragma: no cover
            pass

    def run(self) -> None:
        """Ana thread'de tepsi dongusunu calistirir (bloklar)."""
        self.icon.run()

    def run_detached(self) -> None:
        """Ana thread mesgulse arka planda calistirir (macOS'ta onerilmez)."""
        threading.Thread(target=self.run, name="tray", daemon=True).start()

    def stop(self) -> None:
        try:
            self.icon.stop()
        except Exception:  # pragma: no cover
            pass
