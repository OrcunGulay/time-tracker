"""
Cevrimdisi (offline) kuyruk.

Internet kesildiginde aktivite ornekleri, ekran goruntusu dosya yollari ve
idle kararlari SQLite'ta biriktirilir. Baglanti saglandiginda `sync` modulu
bunlari toplu (batch) olarak sunucuya gonderir.

Idempotency: backend `(session_id, timestamp)` uzerinde unique kisit uygular;
bu yuzden ayni ornegin tekrar gonderilmesi mukerrer kayit olusturmaz.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LOG = logging.getLogger(__name__)

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS activity_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    ts_iso      TEXT NOT NULL,
    payload     TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (session_id, ts_iso)
);
CREATE INDEX IF NOT EXISTS activity_queue_idx ON activity_queue (session_id, ts_iso);

CREATE TABLE IF NOT EXISTS screenshot_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    captured_at   TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    monitor_index INTEGER NOT NULL DEFAULT 0,
    monitor_name  TEXT,
    blur_applied  INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT 'pending',   -- pending | uploaded | dropped
    remote_id     TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (session_id, captured_at, monitor_index)
);
CREATE INDEX IF NOT EXISTS screenshot_queue_state_idx ON screenshot_queue (state, captured_at);

CREATE TABLE IF NOT EXISTS idle_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    event_id     TEXT,
    decision     TEXT NOT NULL,       -- count | discard
    idle_seconds INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    UNIQUE (session_id, event_id)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Buffer:
    """Thread-safe SQLite kuyrugu."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=15.0)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ temel
    def close(self) -> None:
        with self._lock:
            try:
                self._conn.commit()
                self._conn.close()
            except sqlite3.Error:  # pragma: no cover
                pass

    def _execute(self, sql: str, params: Tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            cursor = self._conn.execute(sql, params)
            self._conn.commit()
            return cursor

    # ------------------------------------------------------------------- meta
    def get_meta(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._lock:
            row = self._conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self._execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    # --------------------------------------------------------------- aktivite
    def enqueue_activity(self, session_id: str, sample: Dict[str, Any]) -> bool:
        """Ornegi kuyruga ekler. Ayni (session_id, timestamp) varsa False doner."""
        ts_iso = str(sample.get("timestamp"))
        try:
            self._execute(
                "INSERT INTO activity_queue (session_id, ts_iso, payload, created_at) "
                "VALUES (?, ?, ?, ?)",
                (session_id, ts_iso, json.dumps(sample, ensure_ascii=False), utc_now_iso()),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    def next_activity_batch(self, limit: int = 200) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, session_id, payload, attempts FROM activity_queue "
                "ORDER BY ts_iso ASC LIMIT ?",
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except ValueError:
                self.mark_activity_failed([row["id"]], "bozuk json")
                continue
            result.append({"id": row["id"], "session_id": row["session_id"], "sample": payload})
        return result

    def activity_count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT count(*) AS c FROM activity_queue").fetchone()
        return int(row["c"]) if row else 0

    def mark_activity_sent(self, ids: List[int]) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._execute("DELETE FROM activity_queue WHERE id IN (%s)" % placeholders, tuple(ids))

    def mark_activity_failed(self, ids: List[int], error: str, max_attempts: int = 8) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._execute(
            "UPDATE activity_queue SET attempts = attempts + 1, last_error = ? "
            "WHERE id IN (%s)" % placeholders,
            tuple([error[:400]] + list(ids)),
        )
        # Cok denenen ve sunucu tarafindan reddedilen kayitlari temizle
        self._execute(
            "DELETE FROM activity_queue WHERE attempts >= ? AND last_error IS NOT NULL",
            (max_attempts,),
        )

    def drop_activity_for_session(self, session_id: str) -> int:
        cursor = self._execute("DELETE FROM activity_queue WHERE session_id = ?", (session_id,))
        return cursor.rowcount or 0

    # ------------------------------------------------------------ ekran goruntusu
    def enqueue_screenshot(
        self,
        session_id: str,
        captured_at: str,
        file_path: str,
        content_type: str,
        monitor_index: int = 0,
        monitor_name: Optional[str] = None,
        blur_applied: bool = False,
    ) -> bool:
        try:
            self._execute(
                "INSERT INTO screenshot_queue "
                "(session_id, captured_at, file_path, content_type, monitor_index, monitor_name, "
                " blur_applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    captured_at,
                    file_path,
                    content_type,
                    monitor_index,
                    monitor_name,
                    1 if blur_applied else 0,
                    utc_now_iso(),
                ),
            )
            return True
        except sqlite3.IntegrityError:
            # Ayni kare zaten kuyrukta: dosyayi sil
            if os.path.exists(file_path):
                try:
                    os.unlink(file_path)
                except OSError:
                    pass
            return False

    def pending_screenshots(self, limit: int = 5) -> List[Dict[str, Any]]:
        """Bekleyen kareler. Diskte karsiligi olmayan kayitlar otomatik dusurulur."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM screenshot_queue WHERE state = 'pending' "
                "ORDER BY captured_at ASC LIMIT ?",
                (limit,),
            ).fetchall()

        pending: List[Dict[str, Any]] = []
        for row in rows:
            record = dict(row)
            file_path = record.get("file_path")
            if file_path and not os.path.exists(file_path):
                LOG.warning(
                    "Ekran goruntusu dosyasi bulunamadi, kuyruktan dusuruluyor: %s", file_path
                )
                self.delete_screenshot_row(int(record["id"]), remove_file=False)
                continue
            pending.append(record)
        return pending

    def mark_screenshot_uploaded(self, row_id: int, remote_id: Optional[str]) -> None:
        self._execute(
            "UPDATE screenshot_queue SET state = 'uploaded', remote_id = ? WHERE id = ?",
            (remote_id, row_id),
        )

    def mark_screenshot_failed(self, row_id: int, error: str, max_attempts: int = 10) -> None:
        self._execute(
            "UPDATE screenshot_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?",
            (error[:400], row_id),
        )
        with self._lock:
            row = self._conn.execute(
                "SELECT attempts FROM screenshot_queue WHERE id = ?", (row_id,)
            ).fetchone()
        if row and int(row["attempts"]) >= max_attempts:
            self.delete_screenshot_row(row_id)

    def delete_screenshot_row(self, row_id: int, remove_file: bool = True) -> None:
        with self._lock:
            row = self._conn.execute(
                "SELECT file_path FROM screenshot_queue WHERE id = ?", (row_id,)
            ).fetchone()
        self._execute("DELETE FROM screenshot_queue WHERE id = ?", (row_id,))
        if remove_file and row and row["file_path"] and os.path.exists(row["file_path"]):
            try:
                os.unlink(row["file_path"])
            except OSError:
                pass

    def screenshot_count(self, state: str = "pending") -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT count(*) AS c FROM screenshot_queue WHERE state = ?", (state,)
            ).fetchone()
        return int(row["c"]) if row else 0

    # -------------------------------------------------------------- idle karari
    def enqueue_idle_decision(
        self, session_id: str, decision: str, idle_seconds: int, event_id: Optional[str] = None
    ) -> None:
        try:
            self._execute(
                "INSERT INTO idle_queue (session_id, event_id, decision, idle_seconds, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (session_id, event_id, decision, idle_seconds, utc_now_iso()),
            )
        except sqlite3.IntegrityError:
            # Ayni olay icin daha once karar verilmis: yeni karari uygula
            self._execute(
                "UPDATE idle_queue SET decision = ?, idle_seconds = ? "
                "WHERE session_id = ? AND event_id IS ?",
                (decision, idle_seconds, session_id, event_id),
            )

    def pending_idle_decisions(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM idle_queue ORDER BY created_at ASC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_idle_sent(self, ids: List[int]) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._execute("DELETE FROM idle_queue WHERE id IN (%s)" % placeholders, tuple(ids))

    def mark_idle_failed(self, ids: List[int], error: str) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._execute(
            "UPDATE idle_queue SET attempts = attempts + 1, last_error = ? WHERE id IN (%s)"
            % placeholders,
            tuple([error[:400]] + list(ids)),
        )

    # ---------------------------------------------------------------- bakim
    def stats(self) -> Dict[str, int]:
        return {
            "activity": self.activity_count(),
            "screenshots_pending": self.screenshot_count("pending"),
            "screenshots_uploaded": self.screenshot_count("uploaded"),
            "idle_decisions": len(self.pending_idle_decisions(limit=1000)),
        }

    def total_size_bytes(self) -> int:
        size = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.exists():
                size += candidate.stat().st_size
        return size

    def purge_older_than(self, days: int = 7) -> int:
        """Uzun sure gonderilemeyen kayitlari temizler (disk dolarsa)."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        removed = 0
        cursor = self._execute("DELETE FROM activity_queue WHERE created_at < ?", (cutoff,))
        removed += cursor.rowcount or 0
        cursor = self._execute(
            "DELETE FROM screenshot_queue WHERE created_at < ? AND state != 'pending'", (cutoff,)
        )
        removed += cursor.rowcount or 0
        LOG.info("Kuyruk temizligi: %s kayit silindi (cutoff=%s)", removed, cutoff)
        return removed

    def enforce_size_limit(self, max_mb: int) -> None:
        """Disk kullanimini sinirlar: en eski aktivite kayitlari dusurulur."""
        limit_bytes = max_mb * 1024 * 1024
        if limit_bytes <= 0:
            return
        guard = 0
        while self.total_size_bytes() > limit_bytes and guard < 20:
            guard += 1
            cursor = self._execute(
                "DELETE FROM activity_queue WHERE id IN "
                "(SELECT id FROM activity_queue ORDER BY ts_iso ASC LIMIT 500)"
            )
            if not (cursor.rowcount or 0):
                break
            LOG.warning("Kuyruk boyut siniri asildi: %s aktivite kaydi dusuruldu", cursor.rowcount)
        # Checkpoint: WAL dosyasinin buyumesini engelle
        with self._lock:
            try:
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:  # pragma: no cover
                pass

    def vacuum(self) -> None:
        with self._lock:
            self._conn.execute("VACUUM")

    # Test/bakim yardimcilari
    def wait_for_write(self, timeout: float = 1.0) -> bool:  # pragma: no cover - yalnizca test
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if not self._conn.in_transaction:
                    return True
            time.sleep(0.01)
        return False
