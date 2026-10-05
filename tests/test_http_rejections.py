"""Exercise request rejection over real local sockets without calling providers."""
import http.client
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class RequestRejectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.worker = threading.Thread(
            target=lambda: cls.httpd.serve_forever(poll_interval=0.01), daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.worker.join(timeout=2)

    def post(self, body, headers=None, path="/settings"):
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            conn.request("POST", path, body, request_headers)
            response = conn.getresponse()
            return response.status, response.getheader("Connection"), json.loads(response.read())
        finally:
            conn.close()

    def test_only_approved_brand_assets_are_served_unchanged(self):
        expected = {"/assets/brand/marteloio-%s.png" % name: "image/png"
                    for name in ("light", "dark", "light-64", "dark-64")}
        expected.update({"/assets/fonts/%s-%s-wght-normal.woff2" % (family, subset): "font/woff2"
                         for family in ("manrope", "space-grotesk") for subset in ("latin", "latin-ext")})
        self.assertEqual(server.STATIC_ASSETS, expected)
        for path, content_type in expected.items():
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
            try:
                conn.request("GET", path)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Content-Type"), content_type)
                self.assertEqual(response.read(), (Path(server.BASE_DIR) / path[1:]).read_bytes())
            finally:
                conn.close()
        for path in ("/assets/brand/missing.png", "/assets/brand/../../.env",
                     "/assets/brand/lanzalister-light.png", "/assets/brand/lanzalister-dark.png",
                     "/assets/fonts/OFL-Manrope.txt", "/assets/fonts/"):
            for headers, status in (({}, 403), ({"X-App-Token": server.SESSION_TOKEN}, 404)):
                with self.subTest(path=path, authenticated=bool(headers)):
                    conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                    try:
                        conn.request("GET", path, headers=headers)
                        response = conn.getresponse()
                        self.assertEqual(response.status, status)
                        self.assertIn("error", json.loads(response.read()))
                    finally:
                        conn.close()

    def test_rejected_normal_body_has_readable_403_and_never_routes(self):
        body = json.dumps({"unused": "x" * 32000}).encode()
        bad_headers = (
            {},
            {"X-App-Token": "wrong"},
            {"X-App-Token": "inval\u00edd"},
            {"Host": "outside.example"},
            {"Origin": "https://outside.example"},
            {"Sec-Fetch-Site": "cross-site"},
        )
        with patch.object(server.Handler, "route_post") as route:
            for headers in bad_headers:
                with self.subTest(headers=headers):
                    status, connection, data = self.post(body, headers)
                    self.assertEqual(status, 403)
                    self.assertEqual(connection, "close")
                    self.assertIsInstance(data["error"], str)
            route.assert_not_called()

    def test_maximum_supported_rejected_body_is_readable(self):
        status, connection, data = self.post(b"x" * server.MAX_BODY)
        self.assertEqual((status, connection), (403, "close"))
        self.assertIn("Session expired", data["error"])

    def test_malformed_json_and_invalid_field_types_still_return_400(self):
        expected = {
            b'{"broken":': "Malformed JSON",
            b"[]": "Request body must be a JSON object",
            b"null": "Request body must be a JSON object",
            b"\xff": "Request body is not valid UTF-8",
            b'{"groq_api_key": []}': "Expected a text value",
        }
        with patch.object(server, "write_env") as write_env, \
                patch.object(server.ai_providers, "reset") as restart:
            for body, fragment in expected.items():
                with self.subTest(body=body):
                    status, connection, data = self.post(
                        body, {"X-App-Token": server.SESSION_TOKEN})
                    self.assertEqual((status, connection), (400, "close"))
                    self.assertIn(fragment, data["error"])
            write_env.assert_not_called()
            restart.assert_not_called()

    def test_wrong_content_type_drains_body_and_returns_400(self):
        status, connection, data = self.post(
            b"x" * 32000,
            {"X-App-Token": server.SESSION_TOKEN, "Content-Type": "text/plain"})
        self.assertEqual((status, connection), (400, "close"))
        self.assertIn("application/json", data["error"])

    def test_unknown_post_route_drains_body_and_returns_404(self):
        status, connection, data = self.post(
            b"x" * 32000, {"X-App-Token": server.SESSION_TOKEN}, "/unknown")
        self.assertEqual((status, connection), (404, "close"))
        self.assertEqual(data, {"error": "not found"})

    def raw_headers(self, framing, authenticated=False):
        token = "X-App-Token: %s\r\n" % server.SESSION_TOKEN if authenticated else ""
        return ("POST /settings HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n"
                "Content-Type: application/json\r\n%s%s\r\n" %
                (self.port, token, framing)).encode("ascii")

    def test_unsupported_framing_is_not_drained_or_waited_for(self):
        invalid_framing = (
            "",
            "Content-Length: -1\r\n",
            "Content-Length: 0\r\n",
            "Content-Length: nope\r\n",
            "Content-Length: %d\r\n" % (server.MAX_BODY + 1),
            "Content-Length: " + "9" * 10000 + "\r\n",
            "Content-Length: 2\r\nContent-Length: 2\r\n",
            "Content-Length: 2, 2\r\n",
            "Transfer-Encoding: chunked\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 2\r\n",
        )
        # No body is sent: accepting one of these lengths for draining would
        # stall until the socket/deadline expires. Assert no drain reads occur.
        original = server.Handler.drain_rejected_body

        def record_reads(handler):
            with patch.object(handler.rfile, "read1", side_effect=AssertionError("Unsafe drain")):
                original(handler)

        with patch.object(server.Handler, "drain_rejected_body", record_reads):
            for framing in invalid_framing:
                for authenticated in (False, True):
                    with self.subTest(framing=framing[:80], authenticated=authenticated):
                        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as sock:
                            sock.sendall(self.raw_headers(framing, authenticated))
                            response = http.client.HTTPResponse(sock)
                            response.begin()
                            self.assertEqual(response.status, 400 if authenticated else 403)
                            self.assertIn("error", json.loads(response.read()))

    def test_trickling_body_cannot_extend_total_drain_deadline(self):
        stop = threading.Event()
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as sock:
            sock.sendall(self.raw_headers("Content-Length: 1000\r\n") + b"{")

            def trickle():
                while not stop.wait(0.01):
                    try:
                        sock.sendall(b"x")
                    except OSError:
                        return

            sender = threading.Thread(target=trickle, daemon=True)
            sender.start()
            started = time.monotonic()
            try:
                try:
                    response = http.client.HTTPResponse(sock)
                    response.begin()
                    self.assertEqual(response.status, 403)
                    self.assertIn("error", json.loads(response.read()))
                except ConnectionResetError:
                    # Windows may reset when the peer keeps sending after the
                    # bounded drain. The deadline, not delivery, is guaranteed.
                    pass
                self.assertLess(time.monotonic() - started, 1)
            finally:
                stop.set()
                sender.join(timeout=1)

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            conn.request("GET", path, headers=headers or {})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_huge_integer_temperature_is_a_400_not_a_502(self):
        body = ('{"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}], '
                '"temperature": 1' + "0" * 400 + '}').encode()
        for raw in (body, body.replace(b'"temperature": 1', b'"temperature": -1'),
                    body.replace(b'"temperature": 1' + b"0" * 400, b'"temperature": NaN')):
            with self.subTest(raw=raw[-30:]):
                status, _, data = self.post(raw, {"X-App-Token": server.SESSION_TOKEN},
                                            "/llm/chat/completions")
                self.assertEqual(status, 400)
                self.assertEqual(data["error"], "Invalid temperature")

    def test_out_of_range_max_tokens_is_a_400(self):
        for value in ("63", "3001", "1" + "0" * 400, "true", "800.5", '"800"'):
            raw = ('{"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}], '
                   '"max_tokens": ' + value + '}').encode()
            with self.subTest(value=value[:12]), patch.object(server.ai_providers, "chat") as call:
                status, _, data = self.post(raw, {"X-App-Token": server.SESSION_TOKEN}, "/llm/chat/completions")
                self.assertEqual(status, 400)
                self.assertEqual(data["error"], "Invalid max_tokens")
                call.assert_not_called()

    def test_unreadable_ebay_reference_body_is_a_fixed_502(self):
        auth = {"X-App-Token": server.SESSION_TOKEN}
        path = "/ebay/reference?item_id=v1%7C123%7C0"
        with patch.object(server, "app_token_fresh", return_value="fixture"), \
                patch.object(server, "http_get", return_value=(200, "<html>not json</html>")):
            status, data = self.get(path, auth)
        self.assertEqual(status, 502)
        self.assertEqual(data, {"error": server.UPSTREAM_ERROR_MESSAGE})

    def test_unreadable_ebay_token_body_is_a_fixed_502(self):
        auth = {"X-App-Token": server.SESSION_TOKEN}
        path = "/ebay/reference?item_id=v1%7C123%7C0"
        for body in ("<html>not json</html>", "[]", '{"access_token": "x", "expires_in": "soon"}'):
            with self.subTest(body=body), \
                    patch.dict(server.APP_TOKEN, {"value": None, "expires_at": 0}), \
                    patch.object(server, "client_id", return_value="fixture-id"), \
                    patch.object(server, "client_secret", return_value="fixture-secret"), \
                    patch.object(server, "http_post", return_value=(200, body)), \
                    patch.object(server, "http_get") as listing:
                status, data = self.get(path, auth)
                self.assertEqual(status, 502)
                self.assertEqual(data, {"error": server.UPSTREAM_ERROR_MESSAGE})
                listing.assert_not_called()

    def test_ai_status_requires_session_and_never_exposes_keys(self):
        keys = {"GROQ_API_KEY": "gsk_status_fixture_secret", "GEMINI_API_KEY": ""}
        with patch.object(server, "effective_provider_environment", return_value=keys):
            status, data = self.get("/ai/status")
            self.assertEqual(status, 403)
            self.assertNotIn("providers", data)
            status, data = self.get("/ai/status", {"X-App-Token": server.SESSION_TOKEN})
        self.assertEqual(status, 200)
        self.assertEqual(set(data), {"ready", "retry_in", "providers"})
        self.assertEqual([p["id"] for p in data["providers"]], ["gemini", "groq", "openrouter"])
        self.assertEqual([p["configured"] for p in data["providers"]], [False, True, False])
        self.assertNotIn("gsk_status_fixture_secret", json.dumps(data))
        self.assertNotIn("cret", json.dumps(data))
        with patch.object(server, "load_secrets", side_effect=OSError("fixture")):
            status, data = self.get("/ai/status", {"X-App-Token": server.SESSION_TOKEN})
        self.assertEqual((status, data["ready"], data["error"]), (503, False, server.PROVIDER_STORE_ERROR))

    def test_router_endpoint_is_gone_and_health_reports_ai_readiness(self):
        status, data = self.get("/router/health", {"X-App-Token": server.SESSION_TOKEN})
        self.assertEqual(status, 404)
        with patch.object(server, "effective_provider_environment", return_value={"OPENROUTER_API_KEY": "fixture"}):
            status, data = self.get("/health")
        self.assertEqual(status, 200)
        self.assertNotIn("router_running", data)
        self.assertIs(data["ai_ready"], True)
        # A legacy Mistral key alone no longer makes AI ready.
        with patch.object(server, "effective_provider_environment", return_value={"MISTRAL_API_KEY": "fixture"}):
            status, data = self.get("/health")
        self.assertIs(data["ai_ready"], False)

    def test_generation_only_contacts_public_providers(self):
        # B1/B2 (adopting a foreign router on localhost:4000) cannot recur: the relay
        # never talks to a local AI port, and each request goes straight to HTTPS.
        urls = []

        class Reply:
            def read(self, limit=-1):
                return json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        def fake_open(request, timeout):
            urls.append(request.full_url)
            return Reply()

        body = json.dumps({"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}]}).encode()
        with patch.object(server, "effective_provider_environment", return_value={"GROQ_API_KEY": "gsk_fixture"}), \
                patch.object(server.ai_providers, "_urlopen", side_effect=fake_open), \
                patch.object(server, "outbound_request", side_effect=AssertionError("relay HTTP helper used")):
            status, _, data = self.post(body, {"X-App-Token": server.SESSION_TOKEN}, "/llm/chat/completions")
        self.assertEqual(status, 200)
        self.assertEqual(data["model"], "groq/openai/gpt-oss-120b")
        self.assertEqual(urls, ["https://api.groq.com/openai/v1/chat/completions"])
        source = (Path(server.BASE_DIR) / "server.py").read_text(encoding="utf-8")
        for retired in ("ROUTER_PORT", "litellm", ":4000", '"4000"', "/router/health", "router.log"):
            self.assertNotIn(retired, source)

    def test_valid_json_still_routes_without_mutation(self):
        status, _, data = self.post(b"{}", {"X-App-Token": server.SESSION_TOKEN})
        self.assertEqual(status, 400)
        self.assertIn("nothing to save", data["error"])


if __name__ == "__main__":
    unittest.main()
