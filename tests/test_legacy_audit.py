"""Offline contract regressions for the retained Python dashboard and helpers."""

import asyncio
import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from http.server import HTTPServer

import bot
from config import BotConfig, clean_session_token
from economy import EconomyMonitor, PokemonValuator
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response
from websockets.datastructures import Headers


class TestLegacyConfigAudit(unittest.TestCase):
    def test_boolean_strings_and_numbers_remain_booleans(self):
        for value, expected in [(False, False), (True, True), ("false", False),
                                ("true", True), ("0", False), ("1", True)]:
            with self.subTest(value=value), patch.object(BotConfig, "save"):
                config = BotConfig()
                config.update({"auto_idle": value})
                self.assertIs(config.auto_idle, expected)

    def test_invalid_values_leave_all_fields_unchanged(self):
        for invalid in ["sometimes", None, [], 2]:
            with self.subTest(invalid=invalid), patch.object(BotConfig, "save"):
                config = BotConfig()
                with self.assertRaises(ValueError):
                    config.update({"port": 9000, "auto_idle": invalid})
                self.assertEqual(config.port, 8080)
                self.assertIs(config.auto_idle, True)

    def test_untrusted_keys_cannot_replace_methods(self):
        with patch.object(BotConfig, "save"):
            config = BotConfig()
            config.update({"update": "disabled", "load": False, "unknown": 42})
            self.assertTrue(callable(config.update))
            self.assertTrue(callable(config.load))
            self.assertFalse(hasattr(config, "unknown"))

    def test_load_normalizes_known_types(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "config.json")
            path.write_text(json.dumps({"auto_idle": "false", "port": "8085", "load": 3}), encoding="utf-8")
            config = BotConfig.load(str(path))
            self.assertIs(config.auto_idle, False)
            self.assertEqual(config.port, 8085)
            self.assertTrue(callable(config.load))

    def test_atomic_save_preserves_previous_file_on_replace_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "config.json")
            original = '{"port": 8080}'
            path.write_text(original, encoding="utf-8")
            with patch("config.os.replace", side_effect=OSError("synthetic disk error")):
                with self.assertRaises(OSError):
                    BotConfig(port=9000).save(str(path))
            self.assertEqual(path.read_text(encoding="utf-8"), original)
            self.assertEqual(list(Path(temp).iterdir()), [path])

    def test_update_failure_does_not_change_running_configuration(self):
        config = BotConfig()
        with patch.object(BotConfig, "save", side_effect=OSError("synthetic disk error")):
            with self.assertRaises(OSError):
                config.update({"port": 9000})
        self.assertEqual(config.port, 8080)

    def test_updates_round_trip_in_the_loaded_configuration_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp, "config.json")
            config = BotConfig.load(str(path))
            config.update({"auto_idle": "false", "port": "8085", "catch_hp_pct": "0.25"})
            saved = BotConfig.load(str(path))
            self.assertIs(saved.auto_idle, False)
            self.assertEqual(saved.port, 8085)
            self.assertEqual(saved.catch_hp_pct, 0.25)
            self.assertEqual(list(Path(temp).iterdir()), [path])

    def test_invalid_numeric_domains_are_rejected_transactionally(self):
        for key, value in [("port", 0), ("port", 65536), ("port", 8080.5),
                           ("flee_hp_pct", -0.1), ("catch_hp_pct", 1.5),
                           ("potion_hp_pct", "NaN"), ("min_iv_alert", True),
                           ("discard_iv_pct", 101)]:
            with self.subTest(key=key, value=value), patch.object(BotConfig, "save"):
                config = BotConfig()
                with self.assertRaises(ValueError):
                    config.update({key: value})
                self.assertEqual(getattr(config, key), getattr(BotConfig(), key))

    def test_json_cookie_string_is_normalized(self):
        raw = json.dumps({"cookies": "__Secure-better-auth.session_token=synthetic%2Dsession; unrelated=1"})
        self.assertEqual(clean_session_token(raw), "synthetic-session")


class TestLegacyPackagingAudit(unittest.TestCase):
    def test_spec_resolves_sources_and_assets_from_its_own_directory(self):
        spec = Path(__file__).resolve().parent.parent / "idledex-bot.spec"
        source = spec.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for name in ("bot.py", "dashboard.html", "visualizer.html"):
                (root / name).write_text("synthetic build input", encoding="utf-8")
            captured = {}

            def analysis(scripts, **kwargs):
                captured.update(scripts=scripts, **kwargs)
                return SimpleNamespace(pure=[], zipped_data=[], scripts=[], binaries=[], zipfiles=[], datas=[])

            namespace = {"SPECPATH": str(root), "SPEC": str(root / spec.name), "Analysis": analysis,
                         "PYZ": Mock(), "EXE": Mock(), "COLLECT": Mock()}
            exec(compile(source, str(spec), "exec"), namespace)
            self.assertEqual(captured["pathex"], [str(root)])
            self.assertEqual(captured["scripts"], [str(root / "bot.py")])
            for asset, destination in captured["datas"]:
                self.assertEqual(Path(asset).parent, root)
                self.assertTrue(Path(asset).is_file())
                self.assertEqual(destination, ".")


class TestLegacyHttpAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class FastHandler(bot.DashboardHandler):
            request_timeout = 0.1

        cls.server = HTTPServer(("127.0.0.1", 0), FastHandler)
        cls.server.auth_token = "synthetic-local-auth"
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.fake = bot.IdleDexBot(BotConfig(session_token="synthetic-session", ws_token="synthetic-ws"))
        self.fake.trigger_reconnect = Mock()
        self.fake.trigger_disconnect = Mock()
        self.bot_patch = patch.object(bot, "current_bot", self.fake)
        self.save_patch = patch.object(BotConfig, "save")
        self.bot_patch.start()
        self.save_mock = self.save_patch.start()
        self.addCleanup(self.bot_patch.stop)
        self.addCleanup(self.save_patch.stop)

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        request_headers = {"Host": f"127.0.0.1:{self.port}", "X-Auth-Token": self.server.auth_token}
        request_headers.update(headers or {})
        body = json.dumps(payload) if payload is not None else None
        try:
            connection.request(method, path, body, request_headers)
            response = connection.getresponse()
            return response.status, response.read().decode("utf-8")
        finally:
            connection.close()

    def test_other_loopback_port_cannot_read_auth_bootstrap(self):
        status, body = self.request("GET", "/dashboard", headers={"Origin": "http://127.0.0.1:1"})
        self.assertEqual(status, 403)
        self.assertNotIn(self.server.auth_token, body)

    def test_host_must_match_serving_port(self):
        status, _ = self.request("GET", "/state", headers={"Host": "127.0.0.1:1"})
        self.assertEqual(status, 400)

    def test_config_response_never_contains_credentials(self):
        status, body = self.request("GET", "/api/config")
        self.assertEqual(status, 200)
        self.assertNotIn("synthetic-session", body)
        self.assertNotIn("synthetic-ws", body)

    def test_cookies_string_updates_token_and_reconnects(self):
        status, _ = self.request("POST", "/api/token", {"cookies": "__Secure-better-auth.session_token=synthetic%2Dnew; x=1"})
        self.assertEqual(status, 200)
        self.assertEqual(self.fake.config.session_token, "synthetic-new")
        self.fake.trigger_reconnect.assert_called_once()

    def test_non_object_json_is_rejected_without_disconnect(self):
        for payload in [[], "string", 1, False]:
            with self.subTest(payload=payload):
                status, _ = self.request("POST", "/api/disconnect", payload)
                self.assertEqual(status, 400)
        self.fake.trigger_disconnect.assert_not_called()

    def test_invalid_token_type_does_not_replace_token(self):
        for payload in [{"token": {}}, {"token": ["x"]}, {"cookies": 5}, {"cookies": {"__Secure-better-auth.session_token": []}}]:
            with self.subTest(payload=payload):
                status, _ = self.request("POST", "/api/token", payload)
                self.assertEqual(status, 400)
        self.assertEqual(self.fake.config.session_token, "synthetic-session")
        self.fake.trigger_reconnect.assert_not_called()

    def test_config_validation_returns_400_and_preserves_state(self):
        status, _ = self.request("POST", "/api/config", {"port": 9000, "auto_idle": "not-a-bool"})
        self.assertEqual(status, 400)
        self.assertEqual(self.fake.config.port, 8080)

    def test_failed_token_save_returns_500_without_reconnecting(self):
        self.save_mock.side_effect = OSError("synthetic disk error")
        status, body = self.request("POST", "/api/token", {"token": "synthetic-new"})
        self.assertEqual(status, 500)
        self.assertFalse(json.loads(body)["ok"])
        self.assertEqual(self.fake.config.session_token, "synthetic-session")
        self.fake.trigger_reconnect.assert_not_called()

    def test_incomplete_request_has_a_socket_timeout(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=0.5) as connection:
            connection.sendall(b"GET /state HTTP/1.1\r\n")
            self.assertEqual(connection.recv(100), b"")

    def test_negative_body_length_is_rejected(self):
        status, _ = self.request("POST", "/api/disconnect", headers={"Content-Length": "-1"})
        self.assertEqual(status, 400)
        self.fake.trigger_disconnect.assert_not_called()

    def test_oversize_declaration_returns_413_without_waiting_for_body(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=0.5) as connection:
            request = f"POST /api/config HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Length: 70000\r\n\r\n"
            connection.sendall(request.encode("ascii"))
            self.assertIn(b" 413 ", connection.recv(1024))

    def test_missing_server_auth_token_does_not_disable_authentication(self):
        with patch.object(self.server, "auth_token", None), patch.object(bot, "dashboard_auth_token", None):
            status, _ = self.request("POST", "/api/disconnect", {}, {"X-Auth-Token": ""})
        self.assertEqual(status, 401)
        self.fake.trigger_disconnect.assert_not_called()


class TestLegacyEconomyAudit(unittest.TestCase):
    def test_full_ivs_reach_declared_score_ceiling(self):
        mon = SimpleNamespace(ivs={key: 31 for key in ["hp", "attack", "defense", "sp_atk", "sp_def", "speed"]})
        self.assertAlmostEqual(PokemonValuator()._base_iv_score(mon), 60)

    def test_unknown_stats_do_not_inflate_iv_score(self):
        mon = SimpleNamespace(ivs={"hp": 31, "unknown": 999})
        self.assertLessEqual(PokemonValuator()._base_iv_score(mon), 60)

    def test_suggested_price_uses_only_last_ten_observations(self):
        monitor = EconomyMonitor()
        for price in [1000] * 10 + [100] * 10:
            monitor.record_price(7, price)
        self.assertEqual(monitor.get_suggested_buy_price(7, 200), 90)


class TestLegacyWebsocketAudit(unittest.IsolatedAsyncioTestCase):
    async def test_modern_handshake_401_requires_token_refresh(self):
        client = bot.IdleDexBot(BotConfig())
        attempted = asyncio.Event()

        async def fetch_token():
            if attempted.is_set():
                await asyncio.Future()
            return True

        class RejectedConnection:
            async def __aenter__(self):
                attempted.set()
                raise InvalidStatus(Response(401, "Unauthorized", Headers()))

            async def __aexit__(self, *args):
                return False

        client.fetch_token = fetch_token
        with patch.object(bot.websockets, "connect", return_value=RejectedConnection()):
            task = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(attempted.wait(), 1)
                self.assertTrue(client.needs_token)
                self.assertIn("401", client.token_status)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task


if __name__ == "__main__":
    unittest.main()
