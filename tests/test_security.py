import unittest
from types import SimpleNamespace

from snapgent_bridge.security import origin_allowed, request_origin


class OriginTests(unittest.TestCase):
    def test_extensions_are_allowed(self):
        for origin in ("chrome-extension://abc123", "moz-extension://1f2e3d4c-aaaa-bbbb-cccc-111122223333", "ms-browser-extension://x"):
            self.assertTrue(origin_allowed(origin), origin)

    def test_web_pages_and_missing_origins_are_rejected(self):
        for origin in (None, "", "null", "https://evil.example", "http://127.0.0.1:8000", "file://", "chrome-extension://abc.evil.com/x", "chrome-extension://"):
            self.assertFalse(origin_allowed(origin), origin)

    def test_pinning_narrows_to_exact_origins(self):
        self.assertTrue(origin_allowed("chrome-extension://abc", ["chrome-extension://abc"]))
        self.assertFalse(origin_allowed("chrome-extension://other", ["chrome-extension://abc"]))
        self.assertFalse(origin_allowed("https://evil.example", ["https://evil.example/"]))

    def test_pinning_still_requires_an_origin(self):
        self.assertFalse(origin_allowed(None, ["chrome-extension://abc"]))


class RequestOriginTests(unittest.TestCase):
    def test_new_websockets_api(self):
        ws = SimpleNamespace(request=SimpleNamespace(headers={"Origin": "chrome-extension://a"}))
        self.assertEqual(request_origin(ws), "chrome-extension://a")

    def test_legacy_websockets_api(self):
        ws = SimpleNamespace(request_headers={"Origin": "moz-extension://b"})
        self.assertEqual(request_origin(ws), "moz-extension://b")

    def test_no_headers_at_all(self):
        self.assertIsNone(request_origin(SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
