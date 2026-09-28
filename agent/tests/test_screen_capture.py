"""Ekran goruntusu modulu testleri (mss gerektirmez; kodlama katmani test edilir)."""
import io
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from PIL import Image

    PIL_AVAILABLE = True
except Exception:  # pragma: no cover
    PIL_AVAILABLE = False

from tt_agent.collectors.screen_capture import (  # noqa: E402
    ScreenCaptureService,
    ScreenshotScheduler,
)

MONITOR = {"index": 1, "name": "Monitor 2", "width": 2560, "height": 1440}


@unittest.skipUnless(PIL_AVAILABLE, "Pillow gerekli")
class TestEncoding(unittest.TestCase):
    def _image(self, size=(800, 600)):
        return Image.new("RGB", size, (120, 30, 200))

    def _noise_image(self, size=(400, 400)):
        """Blur etkisini olcebilmek icin yuksek ayrintili goruntu."""
        return Image.effect_noise(size, 120).convert("RGB")

    def test_webp_kodlama(self):
        service = ScreenCaptureService(image_format="webp", quality=70)
        frame = service._encode(self._image(), MONITOR)
        self.assertEqual(frame.content_type, "image/webp")
        self.assertGreater(frame.size_bytes, 0)
        self.assertEqual((frame.width, frame.height), (800, 600))
        self.assertEqual(frame.monitor_name, "Monitor 2")
        # Gecerli bir WebP uretilmis olmali
        reopened = Image.open(io.BytesIO(frame.data))
        self.assertEqual(reopened.format, "WEBP")

    def test_jpeg_kodlama(self):
        service = ScreenCaptureService(image_format="jpeg", quality=70)
        frame = service._encode(self._image(), MONITOR)
        self.assertEqual(frame.content_type, "image/jpeg")
        self.assertEqual(Image.open(io.BytesIO(frame.data)).format, "JPEG")

    def test_png_kodlama(self):
        service = ScreenCaptureService(image_format="png")
        frame = service._encode(self._image(), MONITOR)
        self.assertEqual(frame.content_type, "image/png")

    def test_genislik_sinirlanir(self):
        service = ScreenCaptureService(max_image_width=640)
        frame = service._encode(self._image((2560, 1440)), MONITOR)
        self.assertEqual(frame.width, 640)
        self.assertEqual(frame.height, 360)

    def test_blur_ayrintiyi_azaltir(self):
        plain = ScreenCaptureService(image_format="webp", quality=80, blur_enabled=False)
        blurred_service = ScreenCaptureService(
            image_format="webp", quality=80, blur_enabled=True, blur_radius=12
        )
        noise = self._noise_image()
        plain_frame = plain._encode(noise, MONITOR)
        blurred_frame = blurred_service._encode(noise, MONITOR)
        # Yuksek ayrintili goruntude blur, sikistirilmis boyutu belirgin dusurur
        self.assertLess(blurred_frame.size_bytes, plain_frame.size_bytes)

        # Piksel seviyesinde de dogrula: blur sonrasi yerel varyans azalir
        from PIL import ImageFilter, ImageStat

        variance_plain = ImageStat.Stat(noise).stddev[0]
        variance_blurred = ImageStat.Stat(noise.filter(ImageFilter.GaussianBlur(12))).stddev[0]
        self.assertLess(variance_blurred, variance_plain)

    def test_monitor_index_korunur(self):
        service = ScreenCaptureService()
        frame = service._encode(self._image(), MONITOR)
        self.assertEqual(frame.monitor_index, 1)


class TestPaths(unittest.TestCase):
    def test_dosya_yolu_tarih_ve_monitor_icerir(self):
        moment = datetime(2026, 3, 10, 14, 5, 30, tzinfo=timezone.utc)
        path = ScreenCaptureService.build_path(Path("/tmp/caps"), moment, 2)
        self.assertTrue(str(path).endswith("2026-03-10/140530-m2"))


class TestScheduler(unittest.TestCase):
    def test_rastgele_planlama_blok_icinde(self):
        scheduler = ScreenshotScheduler(block_seconds=600, jitter=True)
        for seed in range(25):
            scheduler._rng.seed(seed)
            scheduler.start(now=1000.0)
            offset = scheduler._next_at - 1000.0
            self.assertGreaterEqual(offset, 0)
            self.assertLess(offset, 600)

    def test_jitter_kapali_ilk_blok_hemen(self):
        scheduler = ScreenshotScheduler(block_seconds=600, jitter=False)
        scheduler.start(now=1000.0)
        self.assertEqual(scheduler._next_at, 1000.0)

    def test_due_ve_mark_captured_dongusu(self):
        scheduler = ScreenshotScheduler(block_seconds=600, jitter=False)
        scheduler.start(now=1000.0)
        self.assertTrue(scheduler.due(now=1000.0))
        # Yakalama isaretlenmeden due her zaman True kalir
        self.assertTrue(scheduler.due(now=1000.1))

        scheduler.mark_captured(now=1000.0)
        # Sonraki blok en erken 600 sn sonra
        self.assertFalse(scheduler.due(now=1599.0))
        self.assertTrue(scheduler.due(now=1600.0))
        self.assertAlmostEqual(scheduler.seconds_until_next(now=1599.5), 0.5)

    def test_minimum_blok_suresi(self):
        self.assertEqual(ScreenshotScheduler(block_seconds=5).block_seconds, 30)


class TestMultiMonitor(unittest.TestCase):
    def test_allowlist_ve_monitor_listesi_mss_olmadan_guvenli(self):
        service = ScreenCaptureService(monitors_allowlist=[1])
        # mss yoksa bos liste doner, hata firlatmaz
        monitors = service.monitors()
        self.assertIsInstance(monitors, list)
        for monitor in monitors:
            self.assertIn(monitor["index"], (0, 1))


if __name__ == "__main__":
    unittest.main()
