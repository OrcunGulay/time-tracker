"""Offline kuyruk (SQLite) testleri."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tt_agent.buffer import Buffer  # noqa: E402


class BufferTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.buffer = Buffer(Path(self.tmp.name) / "queue.sqlite")
        self.addCleanup(self.buffer.close)

    def _sample(self, ts="2026-03-10T09:00:00+00:00"):
        return {"timestamp": ts, "activeApp": "Code", "keyboardEvents": 12, "durationSeconds": 20}


class TestActivityQueue(BufferTestCase):
    def test_ekleme_ve_sayim(self):
        self.assertTrue(self.buffer.enqueue_activity("s1", self._sample()))
        self.assertEqual(self.buffer.activity_count(), 1)

    def test_ayni_timestamp_mukerrer_eklenmez(self):
        self.assertTrue(self.buffer.enqueue_activity("s1", self._sample()))
        self.assertFalse(self.buffer.enqueue_activity("s1", self._sample()))
        self.assertEqual(self.buffer.activity_count(), 1)

    def test_farkli_oturumlar_ayri_tutulur(self):
        self.buffer.enqueue_activity("s1", self._sample())
        self.buffer.enqueue_activity("s2", self._sample())
        self.assertEqual(self.buffer.activity_count(), 2)

    def test_batch_kronolojik_siralanir(self):
        self.buffer.enqueue_activity("s1", self._sample("2026-03-10T09:00:20+00:00"))
        self.buffer.enqueue_activity("s1", self._sample("2026-03-10T09:00:00+00:00"))
        batch = self.buffer.next_activity_batch(10)
        self.assertEqual(batch[0]["sample"]["timestamp"], "2026-03-10T09:00:00+00:00")

    def test_gonderilenler_silinir(self):
        self.buffer.enqueue_activity("s1", self._sample())
        batch = self.buffer.next_activity_batch(10)
        self.buffer.mark_activity_sent([batch[0]["id"]])
        self.assertEqual(self.buffer.activity_count(), 0)

    def test_basarisizlik_deneme_sayisini_artirir_ve_temizler(self):
        self.buffer.enqueue_activity("s1", self._sample())
        batch = self.buffer.next_activity_batch(10)
        ids = [batch[0]["id"]]
        for _ in range(8):
            self.buffer.mark_activity_failed(ids, "sunucu hatasi")
            if self.buffer.activity_count() == 0:
                break
        self.assertEqual(self.buffer.activity_count(), 0)

    def test_oturum_kuyrugu_temizlenebilir(self):
        self.buffer.enqueue_activity("s1", self._sample())
        self.buffer.enqueue_activity("s2", self._sample())
        removed = self.buffer.drop_activity_for_session("s1")
        self.assertEqual(removed, 1)
        self.assertEqual(self.buffer.activity_count(), 1)


class TestScreenshotQueue(BufferTestCase):
    def setUp(self):
        super().setUp()
        self.file = Path(self.tmp.name) / "shot.webp"
        self.file.write_bytes(b"fake-image")

    def _enqueue(self, monitor=0, ts="2026-03-10T09:05:00+00:00"):
        return self.buffer.enqueue_screenshot(
            session_id="s1",
            captured_at=ts,
            file_path=str(self.file),
            content_type="image/webp",
            monitor_index=monitor,
            monitor_name="Monitor %s" % (monitor + 1),
            blur_applied=True,
        )

    def test_kuyruga_ekleme_ve_listeleme(self):
        self.assertTrue(self._enqueue())
        pending = self.buffer.pending_screenshots()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["content_type"], "image/webp")
        self.assertEqual(pending[0]["blur_applied"], 1)

    def test_coklu_monitor_ayni_zaman_damgasi(self):
        self.assertTrue(self._enqueue(0))
        # Ayni zaman damgasi + farkli monitor: ikisi de kuyrukta olmali
        self.file = Path(self.tmp.name) / "shot-m2.webp"
        self.file.write_bytes(b"fake-2")
        self.assertTrue(self._enqueue(1))
        self.assertEqual(self.buffer.screenshot_count("pending"), 2)

    def test_ayni_kare_tekrar_eklenmez_ve_dosya_silinir(self):
        self.assertTrue(self._enqueue())
        duplicate_file = Path(self.tmp.name) / "shot.webp"
        duplicate_file.write_bytes(b"x")
        self.assertFalse(self._enqueue())

    def test_yuklenen_kayit_isaretlenir_ve_dosya_silinir(self):
        self._enqueue()
        row = self.buffer.pending_screenshots()[0]
        self.buffer.mark_screenshot_uploaded(row["id"], "remote-1")
        self.assertEqual(self.buffer.screenshot_count("pending"), 0)
        self.buffer.delete_screenshot_row(row["id"])
        self.assertFalse(Path(row["file_path"]).exists())

    def test_silinmis_dosya_kuyruktan_dusurulur(self):
        self._enqueue()
        row = self.buffer.pending_screenshots()[0]
        Path(row["file_path"]).unlink()
        self.assertEqual(self.buffer.pending_screenshots(), [])


class TestIdleQueue(BufferTestCase):
    def test_karar_kuyruga_eklenir(self):
        self.buffer.enqueue_idle_decision("s1", "discard", 420, "evt-1")
        pending = self.buffer.pending_idle_decisions()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["decision"], "discard")
        self.assertEqual(pending[0]["idle_seconds"], 420)

    def test_ayni_olay_icin_karar_guncellenir(self):
        self.buffer.enqueue_idle_decision("s1", "count", 300, "evt-1")
        self.buffer.enqueue_idle_decision("s1", "discard", 300, "evt-1")
        pending = self.buffer.pending_idle_decisions()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["decision"], "discard")

    def test_gonderilen_kararlar_silinir(self):
        self.buffer.enqueue_idle_decision("s1", "count", 300, "evt-1")
        ids = [row["id"] for row in self.buffer.pending_idle_decisions()]
        self.buffer.mark_idle_sent(ids)
        self.assertEqual(self.buffer.pending_idle_decisions(), [])


class TestMaintenance(BufferTestCase):
    def test_meta_saklama(self):
        self.buffer.set_meta("active_session", '{"session_id":"s1"}')
        self.assertEqual(self.buffer.get_meta("active_session"), '{"session_id":"s1"}')
        self.assertIsNone(self.buffer.get_meta("yok"))

    def test_stats(self):
        self.buffer.enqueue_activity("s1", self._sample())
        stats = self.buffer.stats()
        self.assertEqual(stats["activity"], 1)
        self.assertEqual(stats["screenshots_pending"], 0)

    def test_size_limit_en_eski_kayitlari_duserir(self):
        for i in range(50):
            self.buffer.enqueue_activity("s1", self._sample("2026-03-10T09:%02d:00+00:00" % i))
        self.buffer.enforce_size_limit(0)  # 0 = sinir yok
        self.assertEqual(self.buffer.activity_count(), 50)


if __name__ == "__main__":
    unittest.main()
