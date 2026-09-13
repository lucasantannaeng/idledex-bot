"""
Security test suite for legacy Python HTTP Dashboard (T25).
Verifies loopback isolation, Host/Origin validation, body limits, and token authentication.
"""

import http.client
import json
import threading
import unittest
from http.server import HTTPServer

import bot
from bot import DashboardHandler


class TestLegacySecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), DashboardHandler)
        cls.port = cls.server.server_address[1]
        cls.auth_token = "test-token-1234567890abcdef"
        cls.server.auth_token = cls.auth_token
        bot.dashboard_auth_token = cls.auth_token
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        hdrs = {"Host": f"127.0.0.1:{self.port}"}
        if headers:
            hdrs.update(headers)
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        conn.close()
        return resp.status, resp.headers, data

    def test_unauthenticated_post_rejected(self):
        status, _, body = self._request("POST", "/api/config", {"Content-Type": "application/json"}, "{}")
        self.assertEqual(status, 401)
        data = json.loads(body)
        self.assertFalse(data.get("ok"))

    def test_authenticated_post_with_header(self):
        headers = {
            "Content-Type": "application/json",
            "X-Auth-Token": self.auth_token,
        }
        status, _, _ = self._request("POST", "/api/config", headers, "{}")
        # Bot is not running in test, so 500 'Bot offline' is expected, but NOT 401 Unauthorized
        self.assertNotEqual(status, 401)

    def test_authenticated_post_with_bearer(self):
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.auth_token}",
        }
        status, _, _ = self._request("POST", "/api/config", headers, "{}")
        self.assertNotEqual(status, 401)

    def test_authenticated_post_with_cookie(self):
        headers = {
            "Content-Type": "application/json",
            "Cookie": f"dashboard_token={self.auth_token}",
        }
        status, _, _ = self._request("POST", "/api/config", headers, "{}")
        self.assertNotEqual(status, 401)

    def test_authenticated_post_with_body_token(self):
        headers = {"Content-Type": "application/json"}
        payload = json.dumps({"auth_token": self.auth_token})
        status, _, _ = self._request("POST", "/api/config", headers, payload)
        self.assertNotEqual(status, 401)

    def test_host_header_validation_rejects_external(self):
        headers = {"Host": "attacker.com"}
        status, _, _ = self._request("GET", "/state", headers)
        self.assertEqual(status, 400)

    def test_origin_header_validation_rejects_external(self):
        headers = {"Origin": "https://evil.com"}
        status, _, _ = self._request("GET", "/state", headers)
        self.assertEqual(status, 403)

    def test_origin_header_allowed_for_localhost(self):
        local_origin = f"http://127.0.0.1:{self.port}"
        headers = {"Origin": local_origin}
        status, resp_headers, _ = self._request("GET", "/state", headers)
        self.assertEqual(status, 200)
        self.assertEqual(resp_headers.get("Access-Control-Allow-Origin"), local_origin)

    def test_payload_too_large_rejected(self):
        headers = {
            "Content-Type": "application/json",
            "X-Auth-Token": self.auth_token,
            "Content-Length": "70000",
        }
        status, _, _ = self._request("POST", "/api/config", headers, "x" * 70000)
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main()
