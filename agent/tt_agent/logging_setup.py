"""Log kurulumu: dosyaya ve konsola (silent modda dosyaya yalnizca)."""
from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path
from typing import Optional

LOG_FORMAT = "%(asctime)s %(levelname)-7s [%(threadName)s] %(name)s: %(message)s"


def setup_logging(level: str = "INFO", log_file: Optional[Path] = None, console: bool = True) -> None:
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = logging.Formatter(LOG_FORMAT)

    if console:
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        root.addHandler(stream)

    if log_file is not None:
        try:
            Path(log_file).parent.mkdir(parents=True, exist_ok=True)
            # 5 MB x 3 dosya rotasyonu: uzun suren servis kurulumlari icin
            file_handler = logging.handlers.RotatingFileHandler(
                str(log_file), maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
            )
            file_handler.setFormatter(formatter)
            root.addHandler(file_handler)
        except OSError as exc:  # pragma: no cover
            root.warning("Log dosyasi acilamadi (%s): %s", log_file, exc)

    # Gurultulu kutuphaneleri kis
    for noisy in ("urllib3", "PIL", "pynput"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
