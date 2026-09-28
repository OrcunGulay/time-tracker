"""Yapilandirma yukleme testleri."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tt_agent.config import Config, load_config  # noqa: E402


class TestDefaults(unittest.TestCase):
    def test_varsayilanlar(self):
        config = Config()
        self.assertEqual(config.server_url, "https://time-tracker-api-asll.onrender.com")
        self.assertEqual(config.mode, "interactive")
        self.assertEqual(config.idle_threshold, 180)
        self.assertEqual(config.screenshot_block_seconds, 600)
        self.assertFalse(config.screenshots_enabled)

    def test_server_url_sonundaki_slash_temizlenir(self):
        self.assertEqual(Config(server_url="http://x:4000/").server_url, "http://x:4000")

    def test_gecersiz_mod_reddedilir(self):
        with self.assertRaises(ValueError):
            Config(mode="gizli")

    def test_gecersiz_format_reddedilir(self):
        with self.assertRaises(ValueError):
            Config(image_format="gif")

    def test_idle_esigi_minimum(self):
        with self.assertRaises(ValueError):
            Config(idle_threshold=5)

    def test_yollar_genisletilir(self):
        config = Config(data_dir="~/tt-test")
        self.assertFalse(config.data_dir.startswith("~"))
        self.assertTrue(config.db_path.name.endswith(".sqlite"))


class TestLoading(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env_backup = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env_backup)

    def _write(self, text):
        path = Path(self.tmp.name) / "config.yaml"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_yaml_dosyasindan_okuma(self):
        path = self._write(
            "server_url: http://api.example.com\n"
            "mode: silent\n"
            "idle_threshold: 300\n"
            "screenshots:\n"
            "  enabled: false\n"
        )
        config = load_config(["--config", path])
        self.assertEqual(config.server_url, "http://api.example.com")
        self.assertEqual(config.mode, "silent")
        self.assertEqual(config.idle_threshold, 300)
        self.assertFalse(config.screenshots_enabled)

    def test_ortam_degiskeni_dosyayi_ezmez_ama_uygulanir(self):
        path = self._write("sample_interval: 20\n")
        os.environ["TT_SAMPLE_INTERVAL"] = "45"
        config = load_config(["--config", path])
        self.assertEqual(config.sample_interval, 45)

    def test_komut_satiri_en_yuksek_oncelik(self):
        path = self._write("idle_threshold: 300\n")
        os.environ["TT_IDLE_THRESHOLD"] = "240"
        config = load_config(["--config", path, "--idle-threshold", "120"])
        self.assertEqual(config.idle_threshold, 120)

    def test_parola_ortam_degiskeninden(self):
        os.environ["TT_PASSWORD"] = "gizli-parola"
        config = load_config(["--config", self._write("email: a@b.c\n")])
        self.assertEqual(config.password, "gizli-parola")

    def test_bilinmeyen_anahtar_hata_verir(self):
        path = self._write("bilinmeyen_ayar: 5\n")
        with self.assertRaises(ValueError):
            load_config(["--config", path])

    def test_boolean_coercion(self):
        os.environ["TT_BLUR_ENABLED"] = "true"
        os.environ["TT_SCREENSHOTS_ENABLED"] = "0"
        config = load_config([])
        self.assertTrue(config.blur_enabled)
        self.assertFalse(config.screenshots_enabled)

    def test_liste_coercion(self):
        os.environ["TT_MONITORS_ALLOWLIST"] = "0,2"
        config = load_config([])
        self.assertEqual(config.monitors_allowlist, [0, 2])


if __name__ == "__main__":
    unittest.main()
