"""Fixes from the v0.2.0 QA walkthrough and code review (items 1-7 of that round).

Offline only: temporary data folders, a reversible fake DPAPI, mocked provider calls
and local fake services. Each test failed on the code before these fixes.
"""
import builtins
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers
import launch
import server
from fixtures_v020 import DataFolder, FakeUpstream, RunningApp, fake_dpapi
from test_settings_ai import SettingsCase

GEMINI = "AIzaSyFixtureGeminiKey0123456789abcd"
GROQ = "gsk_fixtureGroqKey0123456789abcdefWXYZ"
FREELLMAPI = "freellmapi-" + "0a1b2c3d" * 6
MESSAGES = [{"role": "user", "content": "Fixture"}]
REJECTED = {"ok": False, "kind": "key_rejected",
            "message": "Groq didn't accept this key. Copy the whole key and paste it again."}


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def answer(text='{"title": "ok"}', finish="stop"):
    return FakeResponse({"choices": [{"message": {"content": text}, "finish_reason": finish}]})


def http_error(code, body):
    return urllib.error.HTTPError("http://fixture.invalid", code, "fixture", {}, io.BytesIO(json.dumps(body).encode()))


class Item1StoreReadErrors(unittest.TestCase):
    """A plain I/O error while reading the store must not set it aside."""

    def setUp(self):
        self.data = DataFolder(self)

    def seed(self):
        with fake_dpapi():
            server.save_provider_settings({"GEMINI_API_KEY": GEMINI})
            self.assertTrue(server.set_ebay_creds("client-id-fixture", "client-secret-fixture"))
        return Path(server.SECRETS_PATH).read_bytes()

    def locked(self, error):
        real = builtins.open

        def opener(path, *args, **kwargs):
            if os.path.abspath(os.fspath(path)) == os.path.abspath(server.SECRETS_PATH):
                raise error
            return real(path, *args, **kwargs)
        return patch.object(server, "open", side_effect=opener, create=True)

    def test_a_locked_store_is_left_alone_and_the_save_fails(self):
        before = self.seed()
        for error in (PermissionError(13, "The process cannot access the file because it is being used by another process"),
                      OSError(362, "The cloud file provider is not running")):
            with self.subTest(error=error.strerror), fake_dpapi(), self.locked(error):
                with self.assertRaises(OSError):
                    server.save_provider_settings({"GROQ_API_KEY": GROQ})
                self.assertFalse(server.set_ebay_creds(cid="other-client-id"))
            self.assertEqual(Path(server.SECRETS_PATH).read_bytes(), before)
            self.assertEqual([n for n in self.data.names() if ".unreadable-" in n], [])
        with fake_dpapi():
            store = server.load_secrets()
        self.assertEqual((store["provider_keys"], store["ebay_client_id"]), ({"GEMINI_API_KEY": GEMINI}, "client-id-fixture"))

    def test_the_one_box_save_reports_it(self):
        self.seed()
        app = RunningApp(self)
        with patch.dict(os.environ), fake_dpapi(), self.locked(PermissionError(13, "in use")):
            status, data = app.request("POST", "/settings/ai", {"provider": "auto", "key": GROQ, "test": False})
        self.assertEqual((status, data["kind"]), (500, "provider_storage_write"))
        self.assertEqual([n for n in self.data.names() if ".unreadable-" in n], [])

    def test_relay_log_names_the_cause(self):
        cases = (("QUJD", "Windows could not decrypt"),             # read, but not for this account
                 ("!!! not base64 !!!", "damaged"))                 # read, but not a store
        for content, phrase in cases:
            with self.subTest(phrase=phrase):
                Path(server.SECRETS_PATH).write_text(content)
                with fake_dpapi(), contextlib.redirect_stderr(io.StringIO()) as log:
                    server.report_unreadable_store()
                    server.save_provider_settings({"GEMINI_API_KEY": GEMINI})
                lines = log.getvalue().strip().splitlines()
                self.assertEqual(len(lines), 2)
                self.assertTrue(all(phrase in line for line in lines), lines)
                os.remove(server.SECRETS_PATH)
        self.seed()
        with fake_dpapi(), self.locked(PermissionError(13, "in use")), contextlib.redirect_stderr(io.StringIO()) as log:
            server.report_unreadable_store()
        self.assertIn("could not be opened", log.getvalue())
        self.assertNotIn("decrypt", log.getvalue())
        self.assertNotIn("damaged", log.getvalue())


class Item2UnreachableFreeLLMAPI(unittest.TestCase):
    KEYS = {"FREELLMAPI_KEY": FREELLMAPI, "FREELLMAPI_URL": "http://10.255.255.1:3001/v1", "GEMINI_API_KEY": GEMINI}

    def setUp(self):
        ai_providers.reset()

    def chat(self, local, keys=None, **kwargs):
        calls = []

        def route(request, timeout):
            calls.append((urlsplit(request.full_url).hostname, timeout))
            if "googleapis" in request.full_url:
                return answer()
            if isinstance(local, BaseException):
                raise local
            return local(request, timeout)
        with patch.object(ai_providers, "_urlopen", side_effect=route):
            return ai_providers.chat(MESSAGES, keys=keys or self.KEYS, **kwargs), calls

    def test_a_connect_failure_is_benched_like_an_outage(self):
        # A refused connection is instant and benched only briefly (test_qa_retest_v020).
        for failure in (urllib.error.URLError(TimeoutError("timed out")),
                        urllib.error.URLError(OSError(113, "No route to host"))):
            with self.subTest(failure=str(failure)):
                ai_providers.reset()
                result, _ = self.chat(failure)
                self.assertEqual(result[1], "gemini")
                state = ai_providers._state["freellmapi"]
                self.assertEqual(state["reason"], "unavailable")
                self.assertGreater(state["until"] - time.time(), 25)
                result, calls = self.chat(failure)
                self.assertEqual([host for host, _ in calls], ["generativelanguage.googleapis.com"])

    def test_a_slow_answer_keeps_the_short_bench(self):
        self.chat(TimeoutError("timed out"))
        state = ai_providers._state["freellmapi"]
        self.assertEqual(state["reason"], "timeout")
        self.assertLessEqual(state["until"] - time.time(), 5.1)

    def test_a_cut_off_retry_leaves_time_for_the_cloud_services(self):
        clock = [1000.0]

        def freellmapi(request, timeout):
            clock[0] += min(timeout, 100)  # works until its time runs out, then cuts off
            return answer('{"title": "cut', "length")
        keys = dict(self.KEYS, FREELLMAPI_URL="http://127.0.0.1:31415/v1")
        with patch.object(ai_providers.time, "monotonic", side_effect=lambda: clock[0]):
            result, calls = self.chat(freellmapi, keys=keys, deadline=1160.0)
        self.assertEqual(result[1], "gemini")
        local = [t for host, t in calls if host == "127.0.0.1"]
        self.assertEqual(len(local), 2)
        self.assertAlmostEqual(local[0], 110)
        self.assertLessEqual(local[1], 15)  # 160 - 100 - 45 left for the cloud
        self.assertGreaterEqual([t for host, t in calls if host != "127.0.0.1"][0], 44)


class Item3UseSwitch(SettingsCase):
    def test_a_new_key_switches_its_service_on(self):
        self.save({"provider": "groq", "key": GROQ, "test": False})
        self.save({"provider": "groq", "enabled": False})
        status, data = self.save({"provider": "auto", "key": GROQ.replace("WXYZ", "ABCD"), "test": False})
        self.assertEqual(status, 200)
        self.assertEqual((self.provider(data, "groq")["enabled"], self.provider(data, "groq")["state"]), (True, "ready"))
        self.assertEqual(server.disabled_providers(), frozenset())
        status, data = self.save({"provider": "groq", "key": GROQ, "enabled": False, "test": False})
        self.assertEqual(self.provider(data, "groq")["enabled"], False)

    def test_every_service_switched_off_is_its_own_error(self):
        body = {"model": "listing-text", "messages": MESSAGES}
        self.save({"provider": "groq", "key": GROQ, "enabled": False, "test": False})
        with patch.object(server.ai_providers, "chat") as chat:
            status, data = self.app.request("POST", "/llm/chat/completions", body)
        chat.assert_not_called()
        self.assertEqual((status, data), (503, {"error": "Every AI service is switched off. Turn one on in Settings \u203a AI.",
                                                "kind": "all_disabled"}))
        self.save({"provider": "groq", "remove": True})
        status, data = self.app.request("POST", "/llm/chat/completions", body)
        self.assertEqual((status, data["kind"]), (503, "no_provider"))


class Item4StricterDetection(unittest.TestCase):
    def test_only_freellmapi_answers_count(self):
        fake = FakeUpstream(self)
        for answer_, found in (((200, {"status": "ok", "ready_upstreams": 2}), True),
                               ((200, {"status": "ok", "ready_upstreams": 0}), True),
                               ((503, {"status": "unavailable", "reason": "no_upstreams_configured"}), True),
                               ((200, {"status": "ok"}), False),
                               ((200, {"status": "ok", "ready_upstreams": "2"}), False),
                               ((200, {"status": "ok", "ready_upstreams": True}), False),
                               ((503, {"status": "ok", "ready_upstreams": 1}), False),
                               ((200, {"status": "unavailable", "reason": "no_upstreams_configured"}), False),
                               ((503, {"status": "unavailable", "reason": "something_else"}), False),
                               ((503, {"status": "unavailable"}), False),
                               ((500, {"status": "unavailable", "reason": "db_unreachable"}), False)):
            fake.routes["/readyz"] = answer_
            with self.subTest(answer=answer_), patch.object(ai_providers, "_desktop_port", return_value=None):
                self.assertEqual(ai_providers._readyz(fake.origin, 1.5) is not None, found)


class Item5TestBeforeSaving(SettingsCase):
    def setUp(self):
        super().setUp()
        self.results = []

    def fake_test(self, name, keys):
        self.tests.append((name, dict(keys), dict(self.env())))  # what was saved when it ran
        return dict(self.results.pop(0)) if self.results else {"ok": True, "ms": 5, "model": "fixture-model"}

    def test_a_rejected_key_does_not_replace_the_saved_one(self):
        self.save({"provider": "groq", "key": GROQ})
        new = GROQ.replace("WXYZ", "ABCD")
        self.results.append(REJECTED)
        status, data = self.save({"provider": "auto", "key": new})
        self.assertEqual(status, 200)
        self.assertEqual((data["saved"], data["provider"], data["test"]), (False, "groq", REJECTED))
        self.assertEqual(self.env()["GROQ_API_KEY"], GROQ, "the working key stays")
        self.assertEqual(self.provider(data, "groq")["key_hint"], "WXYZ")
        name, tested, saved_then = self.tests[-1]
        self.assertEqual((name, tested["GROQ_API_KEY"], saved_then["GROQ_API_KEY"]), ("groq", new, GROQ))

    def test_other_failures_are_saved_with_the_failure(self):
        for kind in ("not_running", "no_upstreams", "unavailable", "timeout", "rate_limited", "bad_response"):
            with self.subTest(kind=kind):
                key = FREELLMAPI.replace("0a1b", kind[:4])
                failure = {"ok": False, "kind": kind, "message": "fixture"}
                self.results.append(failure)
                status, data = self.save({"provider": "auto", "key": key})
                self.assertEqual((status, data["saved"], data["test"]), (200, True, failure))
                self.assertEqual(self.env()["FREELLMAPI_KEY"], key)


class Item5CheckedField(unittest.TestCase):
    KEYS = {"GROQ_API_KEY": GROQ}

    def setUp(self):
        ai_providers.reset()
        ai_providers._checked.clear()

    def checked(self, keys=None):
        return next(p for p in ai_providers.status(keys or self.KEYS)["providers"] if p["id"] == "groq")["checked"]

    def test_checked_follows_tests_and_listings(self):
        self.assertEqual(self.checked(), "")
        with patch.object(ai_providers, "_urlopen", return_value=answer('{"ok": true}')):
            self.assertTrue(ai_providers.test("groq", self.KEYS)["ok"])
        self.assertEqual(self.checked(), "ok")
        ai_providers.reset({"groq"})
        self.assertEqual(self.checked(), "ok", "saving the same key again keeps the mark")
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(500, {})):
            ai_providers.test("groq", self.KEYS)
        self.assertEqual(self.checked(), "failed")
        other = {"GROQ_API_KEY": GROQ.replace("WXYZ", "ABCD")}
        self.assertEqual(self.checked(other), "", "a new key has not been checked")
        with patch.object(ai_providers, "_urlopen", return_value=answer()):
            ai_providers.chat(MESSAGES, keys=other)
        self.assertEqual(self.checked(other), "ok")
        ai_providers.reset()
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(429, {})):
            self.assertRaises(ai_providers.NoProvider, ai_providers.chat, MESSAGES, keys=other)
        self.assertEqual(self.checked(other), "ok", "a busy service is not a failed check")
        ai_providers.reset()
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(401, {})):
            self.assertRaises(ai_providers.NoProvider, ai_providers.chat, MESSAGES, keys=other)
        self.assertEqual(self.checked(other), "failed")
        self.assertEqual(next(p for p in ai_providers.status({})["providers"] if p["id"] == "groq")["checked"], "")
        self.assertIn('"checked"', ai_providers.status.__doc__)

    def test_a_busy_answer_to_the_test_means_the_key_works(self):
        # A 429 comes back only after the service accepted the key, so a seller who pastes a
        # good key at a busy moment must not be told to set up AI again.
        with patch.object(ai_providers, "_urlopen", side_effect=http_error(429, {})):
            result = ai_providers.test("groq", self.KEYS)
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "rate_limited")
        self.assertEqual(self.checked(), "ok")


class Item6FreeLLMAPIIsTheProblem(unittest.TestCase):
    KEYS = {"FREELLMAPI_KEY": FREELLMAPI}
    REFUSED = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
    NO_SERVICES = http_error(503, {"error": {"message": "No models are enabled/configured to serve this request.",
                                             "type": "service_unavailable", "code": "no_providers_configured"}})

    def setUp(self):
        ai_providers.reset()

    def failure(self, outcomes, keys=None, disabled=()):
        def route(request, timeout):
            outcome = outcomes["gemini" if "googleapis" in request.full_url else "freellmapi"]
            raise outcome
        with patch.object(ai_providers, "_urlopen", side_effect=route):
            with self.assertRaises(ai_providers.NoProvider) as raised:
                ai_providers.chat(MESSAGES, keys=keys or self.KEYS, disabled=disabled)
        return raised.exception.code

    def test_not_running_and_no_services(self):
        self.assertEqual(self.failure({"freellmapi": self.REFUSED}), "freellmapi_not_running")
        self.assertEqual(self.failure({"freellmapi": self.REFUSED}), "freellmapi_not_running", "also while it is benched")
        ai_providers.reset()
        self.assertEqual(self.failure({"freellmapi": self.NO_SERVICES}), "freellmapi_no_services")
        keys = dict(self.KEYS, GEMINI_API_KEY=GEMINI)
        ai_providers.reset()
        self.assertEqual(self.failure({"freellmapi": self.REFUSED}, keys, disabled={"gemini"}), "freellmapi_not_running")
        for code, kind, message in (
                ("freellmapi_not_running", "freellmapi_not_running",
                 "FreeLLMAPI isn't running on this computer. Start it, then try again."),
                ("freellmapi_no_services", "freellmapi_no_services",
                 "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.")):
            self.assertEqual(server.provider_failure(code), (503, {"error": message, "kind": kind}))

    def test_other_failures_keep_the_general_kinds(self):
        keys = dict(self.KEYS, GEMINI_API_KEY=GEMINI)
        code = self.failure({"freellmapi": self.REFUSED, "gemini": http_error(429, {})}, keys)
        self.assertEqual(code, "unavailable")
        self.assertEqual(server.provider_failure(code, 30)[1]["kind"], "provider_busy")

    def test_through_the_app(self):
        DataFolder(self)
        app = RunningApp(self)
        with patch.object(server, "effective_provider_environment", return_value=dict(self.KEYS)), \
                patch.object(ai_providers, "_urlopen", side_effect=self.REFUSED):
            status, data = app.request("POST", "/llm/chat/completions", {"model": "listing-text", "messages": MESSAGES})
        self.assertEqual((status, data["kind"]), (503, "freellmapi_not_running"))


class Item7DoubleStart(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="marteloio-race-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        environ = patch.dict(os.environ)
        environ.start()
        self.addCleanup(environ.stop)
        for name in ("PORT", "MARTELOIO_DATA_DIR"):
            os.environ.pop(name, None)

    def test_losing_the_race_to_this_folders_copy_is_success(self):
        exited = Mock(poll=Mock(return_value=1))
        with patch.object(launch, "project_ready", side_effect=[False, False, True]), \
                patch.object(launch, "port_occupied", return_value=True), patch.object(launch.time, "sleep"):
            launch.wait_for_app(exited, 8181, self.base, self.base)

    def test_launch_opens_the_copy_that_won(self):
        with patch.object(launch, "app_health", return_value=None), \
                patch.object(launch, "port_occupied", side_effect=[False, True, True]), \
                patch.object(launch.subprocess, "Popen", return_value=Mock(poll=Mock(return_value=1))), \
                patch.object(launch, "project_ready", side_effect=[False, True]), patch.object(launch.time, "sleep"), \
                patch.object(launch.webbrowser, "open", return_value=True) as browser:
            self.assertEqual(launch.launch(self.base, launch.Messages(quiet=True)), 0)
        browser.assert_called_once_with("http://localhost:8080")

    def test_a_real_crash_is_still_reported(self):
        exited = Mock(poll=Mock(return_value=1))
        for occupied in (False, True):
            with self.subTest(port_held=occupied), patch.object(launch, "project_ready", return_value=False), \
                    patch.object(launch, "port_occupied", return_value=occupied), patch.object(launch.time, "sleep"), \
                    patch.object(launch, "RACE_SECONDS", 0.2):
                with self.assertRaisesRegex(launch.LaunchError, "closed while starting"):
                    launch.wait_for_app(exited, 8181, self.base, self.base)


if __name__ == "__main__":
    unittest.main()
