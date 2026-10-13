"""Fixes from the v0.2.0 QA re-test: instant FreeLLMAPI failures, failed checks kept across
restarts, and the wording for a busy key. Offline only; each test failed before the fix."""
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers
import server
from fixtures_v020 import DataFolder, RunningApp

GROQ = "gsk_fixtureGroqKey0123456789abcdefWXYZ"
FREELLMAPI = "freellmapi-" + "0a1b2c3d" * 6
MESSAGES = [{"role": "user", "content": "Fixture"}]


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def answer(text='{"title": "ok"}'):
    return FakeResponse({"choices": [{"message": {"content": text}, "finish_reason": "stop"}]})


def http_error(code, body=None, headers=None):
    return urllib.error.HTTPError("http://fixture.invalid", code, "fixture", headers or {},
                                  io.BytesIO(json.dumps(body or {}).encode()))


def forget_memory():
    """What a restart does to the in-memory provider state."""
    ai_providers.reset()
    ai_providers._checked.clear()
    ai_providers._fingerprints.clear()


class InstantFreeLLMAPIFailures(unittest.TestCase):
    KEYS = {"FREELLMAPI_KEY": FREELLMAPI}
    REFUSED = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
    NO_SERVICES = http_error(503, {"error": {"message": "No models are enabled/configured to serve this request.",
                                             "code": "no_providers_configured"}})

    def setUp(self):
        forget_memory()

    def chat(self, outcome):
        options = {"return_value": outcome} if isinstance(outcome, FakeResponse) else {"side_effect": outcome}
        with patch.object(ai_providers, "_urlopen", **options):
            try:
                return ai_providers.chat(MESSAGES, keys=self.KEYS)
            except ai_providers.NoProvider as failure:
                return failure

    def test_start_it_then_try_again_works_right_away(self):
        for failure, code in ((self.REFUSED, "freellmapi_not_running"), (self.NO_SERVICES, "freellmapi_no_services")):
            with self.subTest(code=code):
                forget_memory()
                self.assertEqual(self.chat(failure).code, code)
                state = ai_providers._state["freellmapi"]
                self.assertEqual(state["reason"], "unavailable")
                self.assertLessEqual(state["until"] - time.time(), 3.1, "an instant failure is benched briefly")
                # The seller starts FreeLLMAPI (or adds a key there) and chooses Generate again at once.
                self.assertEqual(self.chat(answer())[1], "freellmapi")

    def test_a_connect_timeout_keeps_the_long_bench(self):
        keys = dict(self.KEYS, FREELLMAPI_URL="http://192.168.1.20:3001/v1")
        with patch.object(ai_providers, "_urlopen", side_effect=urllib.error.URLError(TimeoutError("timed out"))):
            self.assertRaises(ai_providers.NoProvider, ai_providers.chat, MESSAGES, keys=keys)
        self.assertGreater(ai_providers._state["freellmapi"]["until"] - time.time(), 25)
        with patch.object(ai_providers, "_urlopen", side_effect=AssertionError("benched: not asked again")):
            self.assertRaises(ai_providers.NoProvider, ai_providers.chat, MESSAGES, keys=keys)


class PersistedFailedChecks(unittest.TestCase):
    def setUp(self):
        environ = patch.dict(os.environ)
        environ.start()
        self.addCleanup(environ.stop)
        for name in list(os.environ):
            if name.endswith(("_API_KEY", "FREELLMAPI_KEY", "FREELLMAPI_URL")):
                del os.environ[name]
        self.data = DataFolder(self)
        self.app = RunningApp(self)
        forget_memory()
        self.addCleanup(forget_memory)

    def save(self, body):
        return self.app.request("POST", "/settings/ai", body)

    def stored(self):
        try:
            with open(server.SETTINGS_PATH, encoding="utf-8") as handle:
                return json.load(handle).get("checked", {})
        except FileNotFoundError:
            return {}

    def checked(self, name="groq"):
        status, data = self.app.request("GET", "/ai/status")
        self.assertEqual(status, 200)
        return next(p for p in data["providers"] if p["id"] == name)["checked"]

    def test_a_failed_test_is_still_failed_after_a_restart(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401)):
            status, data = self.app.request("POST", "/ai/test", {"provider": "groq"})
        self.assertEqual((status, data["kind"]), (200, "key_rejected"))
        self.assertEqual(self.stored(), {"groq": {"key_hint": "WXYZ", "result": "failed"}})
        forget_memory()
        self.assertEqual(self.checked(), "failed")
        with patch.object(ai_providers, "_urlopen", return_value=answer('{"ok": true}')):
            self.assertTrue(self.app.request("POST", "/ai/test", {"provider": "groq"})[1]["ok"])
        self.assertEqual(self.stored(), {})
        forget_memory()
        self.assertEqual(self.checked(), "")
        with open(server.SETTINGS_PATH, encoding="utf-8") as handle:
            self.assertNotIn(GROQ[:-4], handle.read())

    def test_a_rejected_listing_is_remembered_and_a_good_one_forgets_it(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        body = {"model": "listing-text", "messages": MESSAGES}
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401)):
            self.assertEqual(self.app.request("POST", "/llm/chat/completions", body)[1]["kind"], "provider_auth")
        self.assertEqual(self.stored(), {"groq": {"key_hint": "WXYZ", "result": "failed"}})
        forget_memory()
        self.assertEqual(self.checked(), "failed")
        with patch.object(ai_providers, "_urlopen", return_value=answer()):
            self.assertEqual(self.app.request("POST", "/llm/chat/completions", body)[0], 200)
        self.assertEqual(self.stored(), {})

    def test_a_new_or_removed_key_drops_the_entry(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401)):
            self.app.request("POST", "/ai/test", {"provider": "groq"})
        self.save({"provider": "groq", "key": GROQ.replace("WXYZ", "ABCD"), "test": False})
        self.assertEqual(self.stored(), {})
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401)):
            self.app.request("POST", "/ai/test", {"provider": "groq"})
        self.assertEqual(self.stored(), {"groq": {"key_hint": "ABCD", "result": "failed"}})
        self.save({"provider": "groq", "remove": True})
        self.assertEqual(self.stored(), {})

    def test_an_entry_for_another_key_is_ignored(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        server.update_checks({"groq": "ZZZZ"})
        forget_memory()
        self.assertEqual(self.checked(), "")
        server.update_checks({"groq": "WXYZ"})
        self.assertEqual(self.checked(), "failed")

    def test_a_rejected_paste_keeps_the_saved_keys_state(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        with patch.object(ai_providers, "_urlopen", return_value=answer('{"ok": true}')):
            self.app.request("POST", "/ai/test", {"provider": "groq"})
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401)):
            status, data = self.save({"provider": "auto", "key": GROQ.replace("WXYZ", "ABCD")})
        self.assertEqual((status, data["saved"]), (200, False))
        self.assertEqual(self.stored(), {}, "the working key is not marked failed")


class BusyKeyWording(unittest.TestCase):
    def test_a_busy_service_accepted_the_key(self):
        forget_memory()
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(429, headers={"Retry-After": "42"})):
            result = ai_providers.test("groq", {"GROQ_API_KEY": GROQ})
        self.assertEqual(result["kind"], "rate_limited")
        self.assertRegex(result["message"], r"^Groq accepted the key but is busy right now\. "
                                            r"Marteloio will try it again in 4[23] seconds\.$")


if __name__ == "__main__":
    unittest.main()
