"""URL takibi testleri: domain cikarimi, eklenti alicisi ve baslik tahmini."""
import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tt_agent.collectors.url_tracker import (  # noqa: E402
    UrlTracker,
    extract_domain,
    is_browser_app,
)


class TestDomainExtraction(unittest.TestCase):
    def test_protokol_ve_www(self):
        self.assertEqual(extract_domain("https://www.youtube.com/watch?v=a"), "youtube.com")

    def test_alt_alan_adi(self):
        self.assertEqual(extract_domain("https://music.youtube.com/"), "music.youtube.com")

    def test_semasiz_girdi(self):
        self.assertEqual(extract_domain("github.com/org/repo"), "github.com")

    def test_localhost_port(self):
        self.assertEqual(extract_domain("http://localhost:3000/dashboard"), "localhost")

    def test_gecersiz_degerler(self):
        self.assertIsNone(extract_domain(None))
        self.assertIsNone(extract_domain(""))
        self.assertIsNone(extract_domain("Sadece bir baslik"))


class TestBrowserDetection(unittest.TestCase):
    def test_tarayicilar(self):
        for app in ("Google Chrome", "chrome.exe", "Safari", "firefox", "Microsoft Edge", "Arc"):
            self.assertTrue(is_browser_app(app), app)

    def test_tarayici_olmayanlar(self):
        for app in ("Code", "Terminal", "Slack", None, ""):
            self.assertFalse(is_browser_app(app), app)


class TestTitleHeuristic(unittest.TestCase):
    def test_domain_baslikta(self):
        self.assertEqual(
            UrlTracker.domain_from_title("localhost:4000 - Chrome"),
            "localhost",
        )

    def test_bilinen_site_adi(self):
        self.assertEqual(
            UrlTracker.domain_from_title("Komik kedi videosu - YouTube"),
            "youtube.com",
        )
        self.assertEqual(
            UrlTracker.domain_from_title("Pull requests - GitHub"),
            "github.com",
        )

    def test_bilinmeyen_baslik(self):
        self.assertIsNone(UrlTracker.domain_from_title("Belgeler - Word"))


class TestExtensionReceiver(unittest.TestCase):
    def setUp(self):
        self.tracker = UrlTracker(port=0)  # 0 = isletim sistemi bos port secsin
        self.assertTrue(self.tracker.start())
        self.port = self.tracker._server.server_address[1]
        self.addCleanup(self.tracker.stop)

    def _post(self, payload):
        request = urllib.request.Request(
            "http://127.0.0.1:%s/v1/url" % self.port,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_eklenti_bildirimi_kabul_edilir(self):
        status, body = self._post(
            {"url": "https://youtube.com/watch?v=1", "title": "Video", "browser": "chrome"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

        reported = self.tracker.reported_url("Google Chrome")
        self.assertIsNotNone(reported)
        self.assertEqual(reported.url, "https://youtube.com/watch?v=1")

    def test_gecersiz_url_reddedilir(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._post({"url": "javascript:alert(1)", "browser": "chrome"})
        self.assertEqual(ctx.exception.code, 400)

    def test_resolve_tarayici_degilse_bos(self):
        self.assertEqual(self.tracker.resolve("Code", "main.ts", 1), (None, None, None))

    def test_resolve_eklenti_oncelikli(self):
        self._post({"url": "https://github.com/org/repo", "browser": "chrome"})
        url, domain, source = self.tracker.resolve("Google Chrome", "GitHub - Chrome", 1)
        self.assertEqual(url, "https://github.com/org/repo")
        self.assertEqual(domain, "github.com")
        self.assertEqual(source, "extension")

    def test_resolve_baslik_tahminine_duser(self):
        tracker = UrlTracker(port=0, enable_ax=False)
        url, domain, source = tracker.resolve("Google Chrome", "Video - YouTube", 1)
        self.assertIsNone(url)
        self.assertEqual(domain, "youtube.com")
        self.assertEqual(source, "title")


if __name__ == "__main__":
    unittest.main()
