"""Oturum durum makinesi testleri (sahte API istemcisi ile)."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tt_agent.api_client import ApiError, RetryableApiError  # noqa: E402
from tt_agent.buffer import Buffer  # noqa: E402
from tt_agent.session import SessionManager  # noqa: E402


class FakeClient:
    def __init__(self):
        self.started = []
        self.stopped = []
        self.current = None
        self.fail_start = False
        self.has_credentials = True

    def start_session(self, project_id, task_id):
        if self.fail_start:
            raise RetryableApiError(0, "NETWORK_ERROR", "cevrimdisi")
        self.started.append((project_id, task_id))
        return {
            "session": {
                "id": "session-1",
                "projectId": project_id,
                "taskId": task_id,
                "startTime": "2026-03-10T09:00:00+00:00",
            }
        }

    def stop_session(self, session_id, ended_at=None):
        self.stopped.append(session_id)
        return {"session": {"id": session_id, "totalDuration": 3600, "idleDuration": 300}}

    def get(self, path):
        return {"session": self.current}


class SessionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.buffer = Buffer(Path(self.tmp.name) / "q.sqlite")
        self.addCleanup(self.buffer.close)
        self.client = FakeClient()
        self.session = SessionManager(self.client, self.buffer)


class TestLifecycle(SessionTestCase):
    def test_baslangicta_pasif(self):
        self.assertFalse(self.session.is_active)
        self.assertIsNone(self.session.session_id)

    def test_oturum_baslatma(self):
        info = self.session.start("proj-1", "task-1")
        self.assertIsNotNone(info)
        self.assertTrue(self.session.is_active)
        self.assertEqual(self.session.session_id, "session-1")
        self.assertEqual(self.client.started, [("proj-1", "task-1")])

    def test_ikinci_baslatma_mevcut_oturumu_dondurur(self):
        self.session.start("proj-1", None)
        self.session.start("proj-2", None)
        self.assertEqual(len(self.client.started), 1)
        self.assertEqual(self.session.project_id, "proj-1")

    def test_durdurma(self):
        self.session.start(None, None)
        summary = self.session.stop(reason="test")
        self.assertFalse(self.session.is_active)
        self.assertEqual(self.client.stopped, ["session-1"])
        self.assertEqual(summary["totalDuration"], 3600)

    def test_aktif_oturum_yokken_durdurma_guvenli(self):
        self.assertIsNone(self.session.stop("test"))

    def test_cevrimdisi_baslatma_none_doner(self):
        self.client.fail_start = True
        self.assertIsNone(self.session.start(None, None))
        self.assertFalse(self.session.is_active)


class TestRecording(SessionTestCase):
    def test_ornek_yazimi(self):
        self.session.start(None, None)
        sample = {"timestamp": "2026-03-10T09:00:00+00:00", "activeApp": "Code"}
        self.assertTrue(self.session.record(sample))
        self.assertEqual(self.buffer.activity_count(), 1)

    def test_ayni_ornek_iki_kez_yazilmaz(self):
        self.session.start(None, None)
        sample = {"timestamp": "2026-03-10T09:00:00+00:00"}
        self.assertTrue(self.session.record(sample))
        self.assertFalse(self.session.record(sample))

    def test_oturum_yokken_kayit_yapilmaz(self):
        self.assertFalse(self.session.record({"timestamp": "2026-03-10T09:00:00+00:00"}))


class TestAdoption(SessionTestCase):
    def test_sunucudaki_oturum_devralinir(self):
        self.client.current = {
            "id": "session-9",
            "projectId": "proj-9",
            "taskId": None,
            "startTime": "2026-03-10T08:00:00+00:00",
        }
        info = self.session.adopt_existing()
        self.assertIsNotNone(info)
        self.assertEqual(self.session.session_id, "session-9")
        self.assertEqual(self.session.project_id, "proj-9")

    def test_oturum_yoksa_none(self):
        self.client.current = None
        self.assertIsNone(self.session.adopt_existing())

    def test_secim_guncelleme(self):
        self.session.start("proj-1", None)
        self.session.update_selection("proj-2", "task-2")
        self.assertEqual(self.session.project_id, "proj-2")
        self.assertEqual(self.session.task_id, "task-2")


if __name__ == "__main__":
    unittest.main()
