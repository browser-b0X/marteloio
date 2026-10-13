"""The v0.2.0 HTTP routes: one-box AI setup, Use switches, Test, FreeLLMAPI detection, app info.

Real relay on a free local port, a temporary data folder, mocked provider calls only.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers
import app_paths
import server
from fixtures_v020 import DataFolder, RunningApp, fake_dpapi

GEMINI = "AIzaSyFixtureGeminiKey0123456789abcd"
GROQ = "gsk_fixtureGroqKey0123456789abcdefWXYZ"
OPENROUTER = "sk-or-v1-0123456789abcdef0123456789abcdef"
FREELLMAPI = "freellmapi-" + "0a1b2c3d" * 6
PROFILE = "sk-cp-fixtureProfileKey0123456789"
ADDRESS = "http://127.0.0.1:31415/v1/t/flmurl_fixtureAddressToken0123456789"
OK_TEST = {"ok": True, "ms": 812, "model": "fixture-model"}


class SettingsCase(unittest.TestCase):
    def setUp(self):
        environ = patch.dict(os.environ)
        environ.start()
        self.addCleanup(environ.stop)
        for name in list(os.environ):
            if name.endswith(("_API_KEY", "FREELLMAPI_KEY", "FREELLMAPI_URL")) or name.startswith("EBAY_"):
                del os.environ[name]
        self.data = DataFolder(self)
        self.app = RunningApp(self)
        ai_providers.reset()
        self.tests = []
        tester = patch.object(ai_providers, "test", side_effect=self.fake_test)
        tester.start()
        self.addCleanup(tester.stop)
        detect = patch.object(ai_providers, "detect_freellmapi",
                              return_value={"found": False, "ready": False, "base_url": "", "reason": "not_running"})
        self.detect = detect.start()
        self.addCleanup(detect.stop)

    def fake_test(self, name, keys):
        self.tests.append((name, dict(keys)))
        return dict(OK_TEST)

    def save(self, body):
        return self.app.request("POST", "/settings/ai", body)

    def env(self):
        """What was saved: the encrypted store on Windows, the .env file elsewhere."""
        if server.dpapi_available():
            return server.load_secrets().get("provider_keys", {})
        return server.read_env()

    def provider(self, data, name):
        return next(p for p in data["status"]["providers"] if p["id"] == name)


class OneBoxTests(SettingsCase):
    def test_pasted_keys_are_recognised(self):
        cases = [("  'AIzaSyFixtureGeminiKey0123456789abcd'  ", "gemini", "GEMINI_API_KEY", GEMINI, "Google Gemini"),
                 ('"Bearer ' + GROQ + '"', "groq", "GROQ_API_KEY", GROQ, "Groq"),
                 ("bearer " + OPENROUTER + "\n", "openrouter", "OPENROUTER_API_KEY", OPENROUTER, "OpenRouter"),
                 ("\u201c" + FREELLMAPI + "\u201d", "freellmapi", "FREELLMAPI_KEY", FREELLMAPI, "FreeLLMAPI"),
                 (PROFILE, "freellmapi", "FREELLMAPI_KEY", PROFILE, "FreeLLMAPI")]
        for pasted, provider, env, key, label in cases:
            with self.subTest(provider=provider, pasted=pasted[:12]):
                status, data = self.save({"provider": "auto", "key": pasted, "test": False})
                self.assertEqual(status, 200, data)
                self.assertEqual((data["saved"], data["provider"], data["label"], data["test"]), (True, provider, label, None))
                self.assertEqual(self.env()[env], key)
                self.assertEqual(self.provider(data, provider)["key_hint"], key[-4:])
                self.assertNotIn(key[:-4], json.dumps(data))
        self.assertEqual(self.tests, [])

    def test_freellmapi_address_is_saved_as_its_base_url(self):
        status, data = self.save({"provider": "auto", "key": " " + ADDRESS + "/ ", "test": False})
        self.assertEqual((status, data["provider"]), (200, "freellmapi"))
        self.assertEqual(self.env()["FREELLMAPI_URL"], ADDRESS)
        self.assertNotIn("FREELLMAPI_KEY", self.env())
        entry = self.provider(data, "freellmapi")
        self.assertEqual((entry["configured"], entry["key_hint"], entry["base_url"]),
                         (True, "", "http://127.0.0.1:31415/v1/t/\u20266789"))
        self.assertNotIn("fixtureAddressToken", json.dumps(data))

    def test_saving_tests_right_away_and_a_failed_test_is_still_saved(self):
        status, data = self.save({"provider": "gemini", "key": GEMINI})
        self.assertEqual((status, data["test"]), (200, OK_TEST))
        self.assertEqual(self.tests[0][0], "gemini")
        self.assertEqual(self.tests[0][1]["GEMINI_API_KEY"], GEMINI)
        unreachable = {"ok": False, "kind": "unavailable",
                       "message": "Google Gemini couldn't be reached. Check your internet connection and try again."}
        with patch.object(ai_providers, "test", return_value=unreachable):
            status, data = self.save({"provider": "auto", "key": GEMINI.replace("0123", "9999")})
        self.assertEqual((status, data["saved"], data["test"]), (200, True, unreachable))
        self.assertEqual(self.env()["GEMINI_API_KEY"], GEMINI.replace("0123", "9999"))
        # A rejected key is not kept (see test_qa_fixes_v020).
        refused = {"ok": False, "kind": "key_rejected", "message": "Google Gemini didn't accept this key. Copy the whole key and paste it again."}
        with patch.object(ai_providers, "test", return_value=refused):
            status, data = self.save({"provider": "auto", "key": GEMINI})
        self.assertEqual((status, data["saved"], data["test"]), (200, False, refused))

    def test_unknown_invalid_and_empty_input(self):
        cases = [({"provider": "auto", "key": "hello-this-is-not-a-key"}, "unknown_key"),
                 ({"provider": "auto", "key": "https://evil.example/v1/t/flmurl_abc"}, "invalid_url"),
                 ({"provider": "auto", "key": "AIza short key"}, "invalid_key"),
                 ({"provider": "auto", "key": "AIza12"}, "invalid_key"),
                 ({"provider": "auto", "key": "AIza" + "x" * 1100}, "invalid_key"),
                 ({"provider": "groq", "key": "gsk_caf\u00e9-not-ascii-key"}, "invalid_key"),
                 ({"provider": "gemini", "key": "http://127.0.0.1:31415/v1"}, "invalid_key"),
                 ({"provider": "freellmapi", "base_url": "http://api.example.com/v1"}, "invalid_url"),
                 ({"provider": "freellmapi", "base_url": "http://user:pw@127.0.0.1:3001/v1"}, "invalid_url"),
                 ({"provider": "auto"}, "nothing_to_save"),
                 ({"provider": "auto", "key": "  \"\"  "}, "nothing_to_save"),
                 ({"provider": "gemini"}, "nothing_to_save"),
                 ({"provider": "mistral", "key": GEMINI}, "invalid_request"),
                 ({"provider": "gemini", "key": 5}, "invalid_request"),
                 ({"provider": "gemini", "key": GEMINI, "enabled": "yes"}, "invalid_request"),
                 ({"provider": "gemini", "key": GEMINI, "remove": True}, "invalid_request")]
        for body, kind in cases:
            with self.subTest(body=json.dumps(body)[:60]):
                status, data = self.save(body)
                self.assertEqual((status, data["kind"]), (400, kind), data)
                self.assertEqual(set(data), {"error", "kind"})
                key = body.get("key")
                if isinstance(key, str) and len(key) > 8:
                    self.assertNotIn(key.strip()[4:], data["error"])
        self.assertEqual(self.data.names(), [], "nothing was saved")
        self.assertEqual(server.SETTINGS_AI_MESSAGES["unknown_key"],
                         "Marteloio doesn't recognise this key. Copy the whole key from Google AI Studio, Groq, "
                         "OpenRouter or FreeLLMAPI, then paste it again.")

    def test_address_is_only_for_freellmapi(self):
        status, data = self.save({"provider": "auto", "key": GROQ, "base_url": "http://127.0.0.1:3001/v1", "test": False})
        self.assertEqual(status, 200)
        self.assertNotIn("FREELLMAPI_URL", self.env())
        status, data = self.save({"provider": "auto", "key": FREELLMAPI, "base_url": "http://127.0.0.1:3001", "test": False})
        self.assertEqual(self.env()["FREELLMAPI_URL"], "http://127.0.0.1:3001/v1")
        self.detect.assert_not_called()

    def test_freellmapi_found_elsewhere_is_remembered(self):
        self.detect.return_value = {"found": True, "ready": True, "base_url": "http://127.0.0.1:3001/v1", "reason": ""}
        self.save({"provider": "auto", "key": FREELLMAPI, "test": False})
        self.assertEqual(self.env()["FREELLMAPI_URL"], "http://127.0.0.1:3001/v1")
        self.detect.reset_mock()
        self.save({"provider": "auto", "key": FREELLMAPI.replace("0a1b", "9z9z"), "test": False})
        self.detect.assert_not_called()  # an address is saved now

    def test_freellmapi_at_the_default_address_needs_no_address(self):
        self.detect.return_value = {"found": True, "ready": True, "base_url": "http://127.0.0.1:31415/v1", "reason": ""}
        self.save({"provider": "freellmapi", "key": FREELLMAPI, "test": False})
        self.assertNotIn("FREELLMAPI_URL", self.env())

    def test_remove_and_the_use_switch(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        status, data = self.save({"provider": "groq", "enabled": False})
        self.assertEqual((status, data["test"]), (200, None))
        with open(server.SETTINGS_PATH, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"ai": {"groq": {"enabled": False}}})
        entry = self.provider(data, "groq")
        self.assertEqual((entry["enabled"], entry["state"], entry["configured"]), (False, "disabled", True))
        self.assertEqual(server.disabled_providers(), {"groq"})
        # A switched-off service is not used for listings.
        body = {"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}]}
        with patch.object(server.ai_providers, "chat") as chat:
            status, answer = self.app.request("POST", "/llm/chat/completions", body)
        chat.assert_not_called()
        self.assertEqual((status, answer["kind"]), (503, "all_disabled"))
        self.save({"provider": "groq", "enabled": True})
        self.assertEqual(server.disabled_providers(), frozenset())
        status, data = self.save({"provider": "groq", "remove": True})
        self.assertEqual(self.env()["GROQ_API_KEY"], "")
        self.assertEqual(self.provider(data, "groq")["state"], "off")
        self.save({"provider": "freellmapi", "key": FREELLMAPI, "base_url": "http://127.0.0.1:3001/v1", "test": False})
        self.save({"provider": "freellmapi", "remove": True})
        self.assertEqual((self.env()["FREELLMAPI_KEY"], self.env()["FREELLMAPI_URL"]), ("", ""))

    def test_saving_clears_that_services_bench(self):
        self.save({"provider": "gemini", "key": GEMINI, "test": False})
        self.save({"provider": "groq", "key": GROQ, "test": False})
        ai_providers._bench("gemini", "rate_limited", "300")
        ai_providers._bench("groq", "rate_limited", "300")
        status, data = self.save({"provider": "gemini", "key": GEMINI, "test": False})
        self.assertEqual(self.provider(data, "gemini")["state"], "ready")
        self.assertEqual(self.provider(data, "groq")["state"], "rate_limited")

    def test_storage_failure_is_a_500(self):
        with patch.object(server, "save_provider_settings", side_effect=OSError("fixture")):
            status, data = self.save({"provider": "gemini", "key": GEMINI})
        self.assertEqual((status, data["kind"]), (500, "provider_storage_write"))
        self.assertEqual([name for name, _ in self.tests], ["gemini"], "the key is checked before it is saved")
        with patch.object(server, "atomic_write", side_effect=OSError("fixture")):
            status, data = self.save({"provider": "gemini", "enabled": False})
        self.assertEqual((status, data["kind"]), (500, "provider_storage_write"))

    def test_unreadable_store_does_not_block_a_new_key(self):
        """#1 through the one-box setup."""
        Path(server.SECRETS_PATH).write_text("QUJD")
        with fake_dpapi(), contextlib.redirect_stderr(io.StringIO()):
            status, data = self.app.request("GET", "/ai/status")
            self.assertEqual((status, data["kind"]), (503, "provider_storage"))
            status, data = self.save({"provider": "auto", "key": GEMINI, "test": False})
            self.assertEqual(status, 200, data)
            self.assertEqual(self.provider(data, "gemini")["configured"], True)
            self.assertEqual(server.load_secrets()["provider_keys"], {"GEMINI_API_KEY": GEMINI})
        self.assertEqual(len([n for n in self.data.names() if ".unreadable-" in n]), 1)

    def test_old_settings_route_still_works(self):
        status, data = self.app.request("POST", "/settings", {"groq_api_key": GROQ})
        self.assertEqual((status, data["saved"]), (200, ["GROQ_API_KEY"]))
        self.assertEqual(self.env()["GROQ_API_KEY"], GROQ)


class RouteTests(SettingsCase):
    def test_ai_test_route(self):
        status, data = self.app.request("POST", "/ai/test", {"provider": "groq"})
        self.assertEqual((status, data), (200, OK_TEST))
        self.assertEqual(self.tests[0][0], "groq")
        status, data = self.app.request("POST", "/ai/test", {"provider": "nope"})
        self.assertEqual((status, data["kind"]), (400, "invalid_request"))
        status, data = self.app.request("POST", "/ai/test", {"provider": "groq"}, token=False)
        self.assertEqual(status, 403)
        with patch.object(server, "load_secrets", side_effect=OSError("fixture")):
            status, data = self.app.request("POST", "/ai/test", {"provider": "groq"})
        self.assertEqual((status, data["kind"], data["error"]), (503, "provider_storage", server.PROVIDER_STORE_ERROR))

    def test_freellmapi_detect_route_uses_the_saved_address(self):
        self.save({"provider": "auto", "key": ADDRESS, "test": False})
        self.detect.return_value = {"found": True, "ready": False, "base_url": "http://127.0.0.1:31415/v1", "reason": "no_upstreams"}
        status, data = self.app.request("GET", "/ai/freellmapi/detect")
        self.assertEqual((status, data), (200, self.detect.return_value))
        self.detect.assert_called_with(ADDRESS)
        self.assertEqual(self.app.request("GET", "/ai/freellmapi/detect", token=False)[0], 403)

    def test_app_info(self):
        status, data = self.app.request("GET", "/app/info")
        self.assertEqual(status, 200)
        self.assertEqual(set(data), {"version", "build", "installed", "data_dir", "os", "port"})
        self.assertEqual((data["version"], data["build"], data["data_dir"], data["port"]),
                         ("0.2.0", server.BUILD, server.DATA_DIR, self.app.port))
        self.assertRegex(data["build"], r"^[0-9a-f]{12}$")
        self.assertIs(data["installed"], app_paths.INSTALLED)
        self.assertIn(data["os"], ("windows", "mac", "linux", "other"))
        self.assertEqual(self.app.request("GET", "/app/info", token=False)[0], 403)

    def test_health_names_version_and_build(self):
        status, data = self.app.request("GET", "/health", token=False)
        self.assertEqual(status, 200)
        # The build the running copy started with (the launcher compares it with the files on disk).
        self.assertEqual((data["version"], data["build"]), ("0.2.0", server.BUILD))
        self.assertRegex(data["build"], r"^[0-9a-f]{12}$")
        for field in ("ok", "app", "instance", "ebay_configured", "encrypted_storage", "ai_ready", "providers"):
            self.assertIn(field, data)
        self.assertEqual(set(data["providers"]), {"freellmapi", "gemini", "groq", "openrouter"})
        self.assertNotIn("storage_error", data)


class BindTests(unittest.TestCase):
    def test_closing_connections_from_the_last_run_do_not_block_a_restart(self):
        plain = Mock()
        with patch.object(server.os, "name", "nt"), \
                patch.object(server, "ThreadingHTTPServer", side_effect=OSError(10048, "in use")), \
                patch.object(server, "_PlainBindServer", return_value=plain) as fallback, \
                patch.object(server, "port_listening", return_value=False), contextlib.redirect_stderr(io.StringIO()):
            self.assertIs(server.bind_server(8080), plain)
        fallback.assert_called_once()
        self.assertFalse(server._PlainBindServer.exclusive)
        for os_name, listening in (("nt", True), ("posix", False)):
            with self.subTest(os_name=os_name), patch.object(server.os, "name", os_name), \
                    patch.object(server, "ThreadingHTTPServer", side_effect=OSError(98, "in use")), \
                    patch.object(server, "_PlainBindServer") as fallback, \
                    patch.object(server, "port_listening", return_value=listening):
                with self.assertRaises(OSError):
                    server.bind_server(8080)
                fallback.assert_not_called()

    def test_recognition_helpers(self):
        self.assertEqual(ai_providers.recognise(ADDRESS), ("freellmapi", "url"))
        self.assertEqual(ai_providers.recognise("http://127.0.0.1:31415/v1"), (None, None))
        self.assertEqual(ai_providers.clean_pasted(" 'Bearer  AIzaX' "), "AIzaX")
        self.assertEqual(ai_providers.clean_pasted("Bearer \"gsk_x\""), "gsk_x")
        self.assertTrue(re.fullmatch(r"[\x21-\x7e]{8,1024}", "gsk_12345"))
        self.assertTrue(ai_providers.valid_key_text("gsk_1234"))
        self.assertFalse(ai_providers.valid_key_text("gsk_123"))


if __name__ == "__main__":
    unittest.main()
