"""
Girdi aktivitesi testleri - ozellikle GIZLILIK SOZLESMESI dogrulanir.
"""
import inspect
import io
import re
import sys
import tokenize
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tt_agent.collectors import input_activity  # noqa: E402
from tt_agent.collectors.input_activity import (  # noqa: E402
    MAX_MOVE_DELTA,
    InputActivityCollector,
)


def code_only(source: str) -> str:
    """Yorumlari ve string literallerini ayiklar; yalnizca calisan kod kalir.

    Boylece gizlilik testi, dokumantasyon metinlerindeki ornek ifadelerden
    etkilenmez ve gercek kod uzerinde dogrulama yapar.
    """
    buffer = io.StringIO()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in (tokenize.COMMENT, tokenize.STRING):
            continue
        buffer.write(token.string)
        buffer.write(" ")
    return buffer.getvalue()


class TestPrivacyContract(unittest.TestCase):
    """Kaynak kod seviyesinde keylogger olmadigini kanitlar."""

    def setUp(self):
        self.raw_source = inspect.getsource(input_activity)
        self.code = code_only(self.raw_source)

    def test_tus_icerigi_kullanilmiyor(self):
        # `key.char`, `str(key)`, `vk`, `KeyCode` gibi icerik cikarimlari yasak
        forbidden = ["key.char", "str(key", "str(_key", "vk=", "KeyCode", "canonical"]
        for pattern in forbidden:
            self.assertNotIn(
                pattern,
                self.code,
                "GIZLILIK IHLALI: '%s' tus icerigini okuyor" % pattern,
            )

    def test_yorum_ve_dokumanlar_haric_kod_temiz(self):
        # Dokumanda gecen ornek ifadeler testi etkilememeli
        self.assertIn("key.char", self.raw_source)
        self.assertNotIn("key.char", self.code)

    def test_klavye_callback_parametreyi_kullanmaz(self):
        body = code_only(inspect.getsource(InputActivityCollector._on_key_press))
        # Imza disinda `_key` referansi bulunmamali (tam kelime eslesmesi)
        occurrences = re.findall(r"(?<![A-Za-z0-9_])_key(?![A-Za-z0-9_])", body)
        self.assertEqual(
            len(occurrences), 1, "Klavye geri cagrisi tus nesnesini kullaniyor: %s" % body
        )

    def test_snapshot_icerigi_yalnizca_sayaclar(self):
        fields = set(InputActivityCollector().snapshot().__dict__.keys())
        self.assertEqual(
            fields,
            {"keyboard_events", "mouse_events", "mouse_distance", "interval_seconds", "idle_seconds"},
        )


class TestCounters(unittest.TestCase):
    def setUp(self):
        self.collector = InputActivityCollector()

    def test_baslangicta_sayaclar_sifir(self):
        snapshot = self.collector.snapshot()
        self.assertEqual(snapshot.keyboard_events, 0)
        self.assertEqual(snapshot.mouse_events, 0)
        self.assertEqual(snapshot.mouse_distance, 0)
        self.assertFalse(snapshot.has_input)

    def test_klavye_sayaci_artar(self):
        for _ in range(5):
            self.collector._on_key_press(object())
        self.assertEqual(self.collector.snapshot().keyboard_events, 5)

    def test_tik_sayaci_yalnizca_basildiginda_artar(self):
        self.collector._on_click(0, 0, "left", True)
        self.collector._on_click(0, 0, "left", False)
        self.assertEqual(self.collector.snapshot().mouse_events, 1)

    def test_fare_mesafesi_hesaplanir(self):
        self.collector._on_move(0, 0)
        self.collector._on_move(30, 40)  # 50 px
        self.assertEqual(self.collector.snapshot().mouse_distance, 50)

    def test_buyuk_sicramalar_sayilmaz(self):
        self.collector._on_move(0, 0)
        self.collector._on_move(int(MAX_MOVE_DELTA * 2), 0)
        self.assertEqual(self.collector.snapshot().mouse_distance, 0)

    def test_snapshot_sonrasi_sayaclar_sifirlanir(self):
        self.collector._on_key_press(object())
        first = self.collector.snapshot()
        second = self.collector.snapshot()
        self.assertEqual(first.keyboard_events, 1)
        self.assertEqual(second.keyboard_events, 0)

    def test_idle_seconds_artar(self):
        base = self.collector.idle_seconds()
        self.assertGreaterEqual(base, 0.0)
        self.collector.mark_activity()
        self.assertLess(self.collector.idle_seconds(), 0.5)

    def test_snapshot_sozlugu_api_sozlesmesine_uyar(self):
        self.collector._on_key_press(object())
        payload = self.collector.snapshot().as_dict()
        self.assertEqual(
            set(payload.keys()),
            {"keyboardEvents", "mouseEvents", "mouseDistance", "idleSeconds"},
        )

    def test_stop_idempotent(self):
        self.collector.stop()
        self.collector.stop()
        self.assertFalse(self.collector.available)


if __name__ == "__main__":
    unittest.main()
