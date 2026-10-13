"""Regression tests for the v0.2.0 backend bug list (owner's plan numbers in each docstring).

Offline only: mocked provider calls, fake eBay answers, a reversible fake DPAPI and
temporary folders. Each test failed on the v0.1 code.
"""
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers
import app_paths
import launch
import server
from fixtures_v020 import DataFolder, RunningApp, fake_dpapi

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = [{"role": "user", "content": "Fixture"}]
GEMINI = {"GEMINI_API_KEY": "AIzaFixtureGeminiKey1234567890abc"}
GEMINI_GROQ = dict(GEMINI, GROQ_API_KEY="gsk_fixtureGroqKey1234567890abcdef")


class FakeResponse:
    def __init__(self, body):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def answer(text, finish="stop"):
    return FakeResponse({"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}]})


def http_error(code, body=b"{}", headers=None):
    body = body if isinstance(body, bytes) else json.dumps(body).encode()
    return urllib.error.HTTPError("https://fixture.invalid", code, "fixture", headers or {}, io.BytesIO(body))


class Upstream:
    """Mocked _urlopen: routes by provider and model to queued outcomes."""

    def __init__(self, routes, clock=None):
        self.routes, self.calls, self.clock = routes, [], clock

    def __call__(self, request, timeout):
        url = request.full_url
        payload = json.loads(request.data) if request.data else {}
        self.calls.append({"url": url, "model": payload.get("model"), "payload": payload, "timeout": timeout})
        name = next(n for n, spec in ai_providers.PROVIDERS.items() if url.startswith(spec["base"]))
        outcome = self.routes.get((name, payload.get("model")), self.routes.get(name))
        if isinstance(outcome, list):
            outcome = outcome.pop(0)
        if callable(outcome) and not isinstance(outcome, FakeResponse):
            outcome = outcome(url, payload)
        if isinstance(outcome, BaseException):
            raise outcome
        if outcome is None:
            raise AssertionError("Unexpected request to %s" % url)
        return outcome

    def providers(self):
        return [next(n for n, s in ai_providers.PROVIDERS.items() if c["url"].startswith(s["base"])) for c in self.calls]


class ProviderCase(unittest.TestCase):
    def setUp(self):
        ai_providers.reset()

    def chat(self, routes, keys=GEMINI_GROQ, **kwargs):
        upstream = Upstream(routes)
        with patch.object(ai_providers, "_urlopen", side_effect=upstream):
            try:
                return ai_providers.chat(MESSAGES, keys=keys, **kwargs), upstream
            except ai_providers.NoProvider as failure:
                return failure, upstream


class Bug09GeminiWrongKey(ProviderCase):
    GEMINI_400 = [{"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.",
                             "status": "INVALID_ARGUMENT",
                             "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}}]

    def test_bad_gemini_key_is_key_rejected_and_sent_once(self):
        """#9: Gemini's 400 for a wrong key is a rejected key, not 'shorter notes', and is not retried."""
        result, upstream = self.chat({"gemini": http_error(400, self.GEMINI_400)}, keys=GEMINI)
        self.assertIsInstance(result, ai_providers.NoProvider)
        self.assertEqual(result.code, "key_rejected")
        self.assertEqual(len(upstream.calls), 1, "a rejected key must not be retried without response_format")
        state = {p["id"]: p["state"] for p in ai_providers.status(GEMINI)["providers"]}
        self.assertEqual(state["gemini"], "key_rejected")
        self.assertEqual(server.provider_failure(result.code)[1]["kind"], "provider_auth")

    def test_other_key_wordings_and_list_body_shape(self):
        for message in ("Please pass a valid API key.", "API key expired. Please renew the API key."):
            with self.subTest(message=message):
                ai_providers.reset()
                body = {"error": {"code": 400, "message": message, "status": "INVALID_ARGUMENT"}}
                result, _ = self.chat({"gemini": http_error(400, body)}, keys=GEMINI)
                self.assertEqual(result.code, "key_rejected")

    def test_ordinary_400_still_retries_without_response_format(self):
        routes = {"gemini": [http_error(400, {"error": {"message": "response_format is not supported"}}), answer('{"ok": 1}')]}
        result, upstream = self.chat(routes, keys=GEMINI)
        self.assertEqual(result[0], '{"ok": 1}')
        self.assertNotIn("response_format", upstream.calls[1]["payload"])


class Bug10CutOffAnswers(ProviderCase):
    def test_length_cut_off_moves_to_next_provider(self):
        """#10: a reply cut off at the token limit is a failed answer, not a success."""
        cut = answer('{"title": "Vintage Nikon F3", "description": "<p>Clean body with', "length")
        result, upstream = self.chat({"gemini": cut, "groq": answer('{"title": "complete"}')})
        self.assertEqual(result[:2], ('{"title": "complete"}', "groq"))
        self.assertEqual(upstream.providers(), ["gemini", "groq"])
        state = {p["id"]: p["state"] for p in ai_providers.status(GEMINI_GROQ)["providers"]}
        self.assertEqual(state["gemini"], "bad_response")

    def test_unparseable_json_moves_on_but_fenced_json_is_kept(self):
        result, _ = self.chat({"gemini": answer('{"title": "never closed'), "groq": answer('{"title": "groq"}')})
        self.assertEqual(result[1], "groq")
        ai_providers.reset()
        fenced = '```json\n{"title": "fenced"}\n```'
        result, upstream = self.chat({"gemini": answer(fenced)})
        self.assertEqual(result[:2], (fenced, "gemini"))
        self.assertEqual(len(upstream.calls), 1)

    def test_a_cut_off_everywhere_is_a_failed_request(self):
        cut = answer('{"title": "x', "length")
        result, _ = self.chat({"gemini": cut, "groq": cut})
        self.assertIsInstance(result, ai_providers.NoProvider)
        self.assertEqual(result.code, "request")


class Bug11BrokenConnections(ProviderCase):
    def test_incomplete_read_and_bad_status_line_fall_through(self):
        """#11: http.client.HTTPException during a call must not stop the fallback."""
        for failure in (http.client.IncompleteRead(b'{"choices": [', 1024), http.client.BadStatusLine("garbage"),
                        http.client.RemoteDisconnected("closed")):
            with self.subTest(failure=type(failure).__name__):
                ai_providers.reset()
                result, upstream = self.chat({"gemini": failure, "groq": answer('{"title": "groq"}')})
                self.assertEqual(result[1], "groq")
                state = {p["id"]: p["state"] for p in ai_providers.status(GEMINI_GROQ)["providers"]}
                self.assertEqual(state["gemini"], "unavailable")

    def test_model_listing_survives_a_broken_connection(self):
        with patch.object(ai_providers, "_urlopen", side_effect=http.client.IncompleteRead(b"{", 10)):
            self.assertEqual(ai_providers.list_models("groq", "gsk_fixture", 5), [])


class Bug12OpenRouterNeverPaid(ProviderCase):
    KEYS = {"OPENROUTER_API_KEY": "sk-or-v1-fixtureOpenRouterKey1234567890"}
    LISTING = FakeResponse({"data": [{"id": i} for i in (
        "openai/gpt-oss-120b", "openai/gpt-oss-120b:free", "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-3.3-70b-instruct:free", "anthropic/claude-opus-4.1", "qwen/qwen3-coder:free")]})

    def test_privacy_404_is_rejected_request_not_a_retired_model(self):
        """#12: 'No endpoints found matching your data policy' is OpenRouter's privacy setting."""
        policy = http_error(404, {"error": {"message": "No endpoints found matching your data policy (Free model publication). "
                                                       "Configure: https://openrouter.ai/settings/privacy", "code": 404}})
        result, upstream = self.chat({("openrouter", "openrouter/free"): policy, ("openrouter", None): self.LISTING},
                                     keys=self.KEYS)
        self.assertIsInstance(result, ai_providers.NoProvider)
        self.assertEqual(result.code, "request")
        self.assertEqual([c["model"] for c in upstream.calls], ["openrouter/free"], "no other model may be tried")
        state = {p["id"]: p["state"] for p in ai_providers.status(self.KEYS)["providers"]}
        self.assertEqual(state["openrouter"], "request_rejected")
        self.assertIn("privacy", ai_providers.details()["openrouter"].lower())

    def test_discovery_after_a_real_retirement_uses_free_models_only(self):
        gone = http_error(404, {"error": {"message": "openrouter/free is not a valid model ID"}})
        tried = []

        def chat_route(url, payload):
            tried.append(payload["model"])
            return gone if payload["model"] == "openrouter/free" else answer('{"title": "free"}')
        result, upstream = self.chat({("openrouter", None): self.LISTING, "openrouter": chat_route}, keys=self.KEYS)
        self.assertEqual(result[1], "openrouter")
        self.assertTrue(all(m == "openrouter/free" or m.endswith(":free") for m in tried), tried)
        self.assertTrue(result[2].endswith(":free"))

    def test_discovered_list_has_no_paid_models(self):
        with patch.object(ai_providers, "_urlopen", return_value=self.LISTING):
            found = ai_providers._discovered("openrouter", "sk-or-v1-fixture", 5)
        self.assertTrue(found)
        self.assertTrue(all(m.endswith(":free") or m == "openrouter/free" for m in found), found)


class Bug17RetryKeepsTheDeadline(ProviderCase):
    def test_retry_without_response_format_gets_only_the_time_left(self):
        """#17: the JSON-mode retry used a fresh full timeout and overran the deadline."""
        clock = [1000.0]

        def groq(url, payload):
            clock[0] += 6
            if "response_format" in payload:
                return http_error(400, {"error": {"message": "Failed to generate JSON.", "code": "json_validate_failed"}})
            return answer('{"title": "late"}')
        upstream = Upstream({"groq": groq})
        with patch.object(ai_providers, "_urlopen", side_effect=upstream), \
                patch.object(ai_providers.time, "monotonic", side_effect=lambda: clock[0]):
            try:
                ai_providers.chat(MESSAGES, keys={"GROQ_API_KEY": "gsk_fixture1234"}, deadline=1010.0)
            except ai_providers.NoProvider:
                pass
        self.assertEqual(upstream.calls[0]["timeout"], 10.0)
        if len(upstream.calls) > 1:
            self.assertLessEqual(upstream.calls[1]["timeout"], 4.0)


class Bug18SharedEnvParser(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)

    def write(self, text):
        with open(server.ENV_PATH, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

    def test_odd_lines_do_not_crash_and_quotes_are_stripped(self):
        """#18: '=value' crashed startup and quotes were sent with the key."""
        self.write('GEMINI_API_KEY="AIzaQuoted"\n=AIzaPastedOnItsOwnLine\n  # comment\n\nnot a setting\n'
                   "GROQ_API_KEY='gsk_single'\nPORT=\"8081\"\nBAD KEY=x\n")
        with patch.dict(os.environ, {}, clear=True):
            server.load_env()
            self.assertEqual(os.environ.get("GEMINI_API_KEY"), "AIzaQuoted")
            self.assertEqual(os.environ.get("GROQ_API_KEY"), "gsk_single")
            self.assertNotIn("", os.environ)
        env = server.read_env()
        self.assertEqual(env["GEMINI_API_KEY"], "AIzaQuoted")
        self.assertEqual(env["PORT"], "8081")
        self.assertNotIn("BAD KEY", env)
        self.assertEqual(launch.launch_environment(Path(self.data.path), {})[1], 8081)

    def test_one_parser_for_server_and_launcher(self):
        self.write('A="1"\nB=2\n')
        self.assertEqual(app_paths.read_env_file(server.ENV_PATH), {"A": "1", "B": "2"})
        self.assertEqual(server.read_env(), app_paths.read_env_file(server.ENV_PATH))


class Bug19ExclusivePort(unittest.TestCase):
    def test_windows_bind_is_exclusive_without_reuse(self):
        """#19: SO_REUSEADDR let a second copy share the port on Windows."""
        sock = Mock()
        sock.getsockname.return_value = ("127.0.0.1", 8080)
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler, bind_and_activate=False)
        httpd.socket.close()
        httpd.socket = sock
        with patch.object(server.os, "name", "nt"), \
                patch.object(socket, "SO_EXCLUSIVEADDRUSE", -5, create=True):
            httpd.server_bind()
        options = [c.args[1] for c in sock.setsockopt.call_args_list]
        self.assertIn(-5, options)
        self.assertNotIn(socket.SO_REUSEADDR, options)

    def test_second_copy_cannot_share_the_port(self):
        first = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.addCleanup(first.server_close)
        with self.assertRaises(OSError):
            server.ThreadingHTTPServer(("127.0.0.1", first.server_address[1]), server.Handler).server_close()


class Bug01UnreadableStore(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)
        Path(server.SECRETS_PATH).write_text("QUJD")  # a blob this Windows account cannot decrypt
        self.unreadable = Path(server.SECRETS_PATH).read_bytes()

    def test_health_stays_up_and_reports_storage(self):
        """#1: /health answered 502, so the launcher never saw the app as ready."""
        with fake_dpapi():
            app = RunningApp(self)
            status, data = app.request("GET", "/health", token=False)
        self.assertEqual(status, 200)
        self.assertIs(data["ok"], True)
        self.assertIs(data.get("storage_error"), True)
        self.assertIs(data["ebay_configured"], False)

    def test_ai_status_is_503_with_storage_kind(self):
        with fake_dpapi():
            status, data = RunningApp(self).request("GET", "/ai/status")
        self.assertEqual(status, 503)
        self.assertEqual((data["kind"], data["ready"], data["providers"]), ("provider_storage", False, []))

    def test_saving_a_key_sets_the_unreadable_store_aside(self):
        stderr = io.StringIO()
        with fake_dpapi(), contextlib.redirect_stderr(stderr):
            server.save_provider_settings({"GEMINI_API_KEY": "AIzaRecoveredKeyFixture123"})
            self.assertEqual(server.load_secrets()["provider_keys"], {"GEMINI_API_KEY": "AIzaRecoveredKeyFixture123"})
        kept = [n for n in self.data.names() if n.startswith(".marteloio-secrets.unreadable-")]
        self.assertEqual(len(kept), 1, self.data.names())
        self.assertRegex(kept[0], r"^\.marteloio-secrets\.unreadable-\d{8}-\d{6}(-\d+)?\.enc$")
        self.assertEqual(Path(self.data.file(kept[0])).read_bytes(), self.unreadable)
        log = stderr.getvalue()
        self.assertIn(kept[0], log)
        self.assertNotIn("AIzaRecovered", log)


class Bug14MalformedTokenMigration(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)

    def test_non_object_token_file_is_left_alone(self):
        """#14: '[]' was copied into the store and broke every later read."""
        for raw in ("[]", '"text"', '{"access_token": 5}', "{}"):
            with self.subTest(raw=raw):
                for name in os.listdir(self.data.path):
                    os.remove(self.data.file(name))
                Path(server.TOKEN_PATH).write_text(raw)
                Path(server.ENV_PATH).write_text("EBAY_CLIENT_ID=Seller-App-PRD-fixture\n")
                out = io.StringIO()
                with fake_dpapi(), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out), \
                        patch.dict(os.environ):
                    server.migrate_secrets()
                    store = server.load_secrets()
                self.assertEqual(store.get("ebay_client_id"), "Seller-App-PRD-fixture")
                self.assertNotIn("token", store)
                self.assertEqual(Path(server.TOKEN_PATH).read_text(), raw)
                self.assertIn(".ebay_token.json", out.getvalue())


class Bug15And16EbayErrors(unittest.TestCase):
    def setUp(self):
        server.invalidate_ebay_cache()
        self.addCleanup(server.invalidate_ebay_cache)

    def test_rejected_ebay_keys_say_so(self):
        """#15: a token endpoint 400/401 said 'temporarily unavailable, retry'."""
        for code in (400, 401):
            with self.subTest(code=code), patch.object(server, "client_id", return_value="Seller-App-PRD-1"), \
                    patch.object(server, "client_secret", return_value="PRD-wrong"), \
                    patch.object(server, "http_post", side_effect=http_error(code, b'{"error":"invalid_client"}')):
                server.invalidate_ebay_cache()
                result = server.try_search("nikon f3", 20)
                self.assertEqual(result["kind"], "ebay_auth")
                self.assertEqual(result["error"], server.EBAY_MESSAGES["ebay_auth"])
                app = RunningApp(self)
                status, data = app.request("GET", "/ebay/search?keywords=nikon%20f4&limit=20")
                self.assertEqual((status, data["kind"]), (502, "ebay_auth"))

    def test_a_missing_client_secret_is_not_configured(self):
        app = RunningApp(self)
        with patch.object(server, "client_id", return_value="Seller-App-PRD-1"), \
                patch.object(server, "client_secret", return_value=""), \
                patch.object(server, "http_post", side_effect=AssertionError("no token request without a secret")):
            status, data = app.request("GET", "/ebay/search?keywords=nikon&limit=20")
        self.assertEqual((status, data["kind"]), (200, "ebay_not_configured"))

    def test_ended_listing_is_gone_not_a_server_failure(self):
        """#16: eBay's 404 for an ended listing became a generic 502."""
        app = RunningApp(self)
        with patch.object(server, "client_id", return_value="Seller-App-PRD-1"), \
                patch.object(server, "app_token_fresh", return_value="app-token"), \
                patch.object(server, "http_get", side_effect=http_error(404, b'{"errors":[{"errorId":11001}]}')):
            status, data = app.request("GET", "/ebay/reference?item_id=v1%7C123456789012%7C0")
        self.assertEqual(status, 404)
        self.assertEqual(data, {"error": "This listing is no longer on eBay. Pick another one.", "kind": "ebay_listing_gone"})


class Bug21BrowserFailure(unittest.TestCase):
    def test_browser_failure_exits_1_with_the_address(self):
        """#21: the launcher exited 0, so start-all.bat closed before the message could be read."""
        base = Path(tempfile.mkdtemp(prefix="marteloio-launch-"))
        self.addCleanup(shutil.rmtree, base, True)
        running = {"ok": True, "app": "Marteloio", "instance": launch.instance_id(base), "build": app_paths.build_id(str(base))}
        stderr, stdout = io.StringIO(), io.StringIO()
        with patch.object(launch, "BASE_DIR", base), patch.object(launch, "app_health", return_value=running), \
                patch.object(launch.subprocess, "Popen", side_effect=AssertionError("no server may start")), \
                patch.object(launch.webbrowser, "open", return_value=False), patch.dict(os.environ, {"PORT": "8181"}), \
                contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            os.environ.pop("MARTELOIO_DATA_DIR", None)
            code = launch.main([])
        self.assertEqual(code, 1)
        self.assertIn("http://localhost:8181", stderr.getvalue())


class Bug22StartFromZip(unittest.TestCase):
    def test_start_all_explains_the_zip(self):
        """#22: running start-all.bat inside the ZIP failed with a raw 'can't open file' error."""
        text = (ROOT / "start-all.bat").read_text(encoding="ascii")
        message = ("Marteloio is still inside the ZIP file. Right-click the ZIP, choose Extract All, "
                   "then open the extracted folder and run start-all.bat again.")
        self.assertIn('if not exist "%~dp0server.py"', text)
        block = text[text.index('if not exist "%~dp0server.py"'):]
        self.assertIn("echo " + message, block.splitlines()[1])
        self.assertLess(text.index('if not exist "%~dp0server.py"'), text.index("where python"))
        self.assertIn("pause", block.split(")")[0])


class Bug31LongNotes(unittest.TestCase):
    def test_long_notes_have_their_own_kind(self):
        """#31: 40,000+ characters said 'Invalid message content' and the UI blamed the keys."""
        app = RunningApp(self)
        notes = "x" * 40001
        body = {"model": "listing-text", "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": notes}]}
        with patch.object(server.ai_providers, "chat") as chat:
            status, data = app.request("POST", "/llm/chat/completions", body)
        chat.assert_not_called()
        self.assertEqual(status, 400)
        self.assertEqual(data, {"error": "These notes are too long for one listing (over 40,000 characters). "
                                         "Shorten them and try again.", "kind": "notes_too_long"})


class Bug35PortEighty(unittest.TestCase):
    def handler(self, host, port, origin=None):
        handler = server.Handler.__new__(server.Handler)
        handler.server = Mock(server_address=("127.0.0.1", port))
        handler.headers = {"Host": host} if origin is None else {"Host": host, "Origin": origin}
        handler.reject_json = Mock()
        return handler

    def test_port_80_accepts_a_host_without_port(self):
        """#35: browsers send 'Host: localhost' for port 80 and every request was refused."""
        for host in ("localhost", "127.0.0.1", "localhost:80"):
            with self.subTest(host=host):
                handler = self.handler(host, 80, "http://" + host)
                self.assertTrue(handler.validate_request())
                handler.reject_json.assert_not_called()
        for host, port in (("localhost", 8080), ("evil.example", 80), ("localhost:8080", 80)):
            with self.subTest(host=host, port=port):
                self.assertFalse(self.handler(host, port).validate_request())


class ErrorKinds(unittest.TestCase):
    def test_every_json_error_carries_a_kind(self):
        app = RunningApp(self)
        cases = [("GET", "/ebay/search?limit=20", None), ("GET", "/ebay/search?gtin=123", None),
                 ("POST", "/settings", {}), ("POST", "/settings/ebay", {}), ("POST", "/nope", {}),
                 ("POST", "/llm/chat/completions", {"model": "other"}), ("GET", "/nope", None)]
        for method, path, body in cases:
            with self.subTest(path=path):
                status, data = app.request(method, path, body)
                self.assertGreaterEqual(status, 400)
                self.assertIsInstance(data.get("kind"), str, data)
                self.assertTrue(data["kind"])
        status, data = app.request("GET", "/ebay/search?gtin=123", None)
        self.assertEqual((status, data["kind"]), (400, "invalid_barcode"))
        self.assertEqual(data["error"], "Check the barcode: it should have 8, 12, 13 or 14 digits.")
        status, data = app.request("GET", "/settings", token=False)
        self.assertEqual((status, data["kind"]), (403, "session_expired"))


if __name__ == "__main__":
    unittest.main()
