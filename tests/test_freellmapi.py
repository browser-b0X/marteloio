"""FreeLLMAPI support, against a fake FreeLLMAPI on a free local port.

Cloud providers are mocked; nothing leaves this computer and no real key is used.
"""
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
import urllib.request
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers
from fixtures_v020 import FakeUpstream, closed_port

KEY = "freellmapi-" + "0a1b2c3d" * 6
GEMINI_KEY = "AIzaFixtureGeminiKey1234567890abc"
MESSAGES = [{"role": "system", "content": "S"}, {"role": "user", "content": "Notes"}]
TALLY = ("All 2 routed attempt(s) failed with upstream provider errors (%s). This is a provider-side "
         "failure, not a problem with your request; retry, or check provider status.")


def completion(text='{"title": "from FreeLLMAPI"}', finish="stop"):
    return 200, {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}]}


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


GEMINI_ANSWER = FakeResponse({"choices": [{"message": {"content": '{"title": "from Gemini"}'}, "finish_reason": "stop"}]})


class FreeLLMAPICase(unittest.TestCase):
    def setUp(self):
        ai_providers.reset()
        self.fake = FakeUpstream(self)
        self.base = self.fake.origin + "/v1"
        self.cloud_calls = []

    def keys(self, **extra):
        return dict({"FREELLMAPI_KEY": KEY, "FREELLMAPI_URL": self.base}, **extra)

    def opener(self, cloud=None):
        """Local addresses reach the fake server for real; cloud calls get canned answers."""
        real = ai_providers._urlopen

        def route(request, timeout):
            if urlsplit(request.full_url).hostname == "127.0.0.1":
                return real(request, timeout)
            self.cloud_calls.append((request.full_url, timeout))
            outcome = cloud.pop(0) if isinstance(cloud, list) else cloud
            if outcome is None:
                raise AssertionError("unexpected cloud request")
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        return patch.object(ai_providers, "_urlopen", side_effect=route)

    def chat(self, keys, cloud=None, **kwargs):
        with self.opener(cloud):
            try:
                return ai_providers.chat(MESSAGES, keys=keys, **kwargs)
            except ai_providers.NoProvider as failure:
                return failure

    def provider(self, keys, name="freellmapi", disabled=()):
        return next(p for p in ai_providers.status(keys, disabled)["providers"] if p["id"] == name)


class ChatTests(FreeLLMAPICase):
    def test_tried_first_with_its_own_request_shape(self):
        self.fake.routes["/v1/chat/completions"] = completion()
        result = self.chat(self.keys(GEMINI_API_KEY=GEMINI_KEY), max_tokens=800)
        self.assertEqual(result, ('{"title": "from FreeLLMAPI"}', "freellmapi", "auto:fast"))
        self.assertEqual(self.cloud_calls, [])
        call = self.fake.calls[0]
        self.assertEqual(call["authorization"], "Bearer " + KEY)
        body = call["body"]
        self.assertEqual(body["model"], "auto:fast")
        self.assertEqual(body["max_tokens"], 800 + 4000)  # room to think
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["messages"][-1]["content"], "Notes\n\n{reasoning effort: low}")
        self.assertEqual(body["messages"][0], {"role": "system", "content": "S"})
        self.assertEqual(MESSAGES[-1]["content"], "Notes", "the caller's messages must not change")

    def test_falls_back_to_gemini_without_the_prompt_suffix(self):
        self.fake.routes["/v1/chat/completions"] = (503, {"error": {"message": "busy"}})
        with patch.object(ai_providers, "_post", wraps=ai_providers._post) as post:
            result = self.chat(self.keys(GEMINI_API_KEY=GEMINI_KEY), cloud=GEMINI_ANSWER)
        self.assertEqual(result[1], "gemini")
        gemini_payload = post.call_args_list[-1].args[2]
        self.assertEqual(gemini_payload["messages"], MESSAGES)
        self.assertNotIn("thinking", json.dumps(gemini_payload))
        self.assertEqual(self.provider(self.keys())["state"], "unavailable")

    def test_tokenised_address_needs_no_key_and_sends_no_authorization(self):
        address = self.base + "/t/flmurl_fixtureToken0123456789abcd"
        self.fake.routes["/v1/t/flmurl_fixtureToken0123456789abcd/chat/completions"] = completion()
        keys = {"FREELLMAPI_URL": address + "/"}
        self.assertTrue(ai_providers.configured("freellmapi", keys))
        self.assertEqual(self.chat(keys)[1], "freellmapi")
        self.assertIsNone(self.fake.calls[0]["authorization"])
        status = self.provider(keys)
        self.assertEqual((status["key_hint"], status["base_url"]), ("", self.base + "/t/\u2026abcd"))
        self.assertNotIn("fixtureToken", json.dumps(ai_providers.status(keys)))

    def test_address_alone_without_token_is_not_configured(self):
        keys = {"FREELLMAPI_URL": self.base}
        self.assertFalse(ai_providers.configured("freellmapi", keys))
        result = self.chat(keys)
        self.assertEqual((result.code, self.fake.calls), ("no_provider", []))
        self.assertEqual(self.provider(keys)["state"], "off")

    def test_default_address_is_the_desktop_app(self):
        status = self.provider({"FREELLMAPI_KEY": KEY})
        self.assertEqual(status["base_url"], "http://127.0.0.1:31415/v1")
        self.assertEqual(ai_providers.PROVIDERS["freellmapi"]["base"], "http://127.0.0.1:31415/v1")
        self.assertEqual(status["key_hint"], KEY[-4:])
        # A bare address gets /v1.
        self.assertEqual(ai_providers.normalize_base("http://127.0.0.1:3001/"), "http://127.0.0.1:3001/v1")

    def test_only_addresses_on_this_computer_or_the_home_network(self):
        for good in ("http://127.0.0.1:31415/v1", "http://localhost:3001", "https://[::1]:3001/v1", "http://freellmapi.local:3001/v1",
                     "http://10.0.0.5:3001/v1", "http://172.16.0.1/v1", "http://172.31.255.254/v1", "http://192.168.1.20:31415/v1/t/flmurl_x"):
            self.assertTrue(ai_providers.valid_local_url(good), good)
        for bad in ("http://example.com/v1", "http://8.8.8.8/v1", "ftp://127.0.0.1/v1", "http://user:pass@127.0.0.1/v1",
                    "http://127.0.0.1@evil.example/v1", "http://172.32.0.1/v1", "http://192.169.1.1/v1", "http://127.999.0.1/v1",
                    "http://0x7f000001/v1", "http://[::2]/v1", "http://evil.com\\.local/v1", "http://127.0.0.1:99999/v1",
                    "http://127.0.0.1/v1?x=1", "http://127.0.0.1/v1#x", "http://127.0.0.1/ v1", "", None, 5, "http://" + "a" * 3000):
            self.assertFalse(ai_providers.valid_local_url(bad), bad)
        # A remote address in .env is ignored: the key goes nowhere but this computer.
        status = self.provider({"FREELLMAPI_KEY": KEY, "FREELLMAPI_URL": "http://api.example.com/v1"})
        self.assertEqual(status["base_url"], "http://127.0.0.1:31415/v1")

    def test_local_requests_never_use_a_proxy(self):
        self.fake.routes["/v1/chat/completions"] = completion()
        dead = "http://127.0.0.1:%d" % closed_port()
        environ = {"HTTP_PROXY": dead, "http_proxy": dead, "HTTPS_PROXY": dead, "https_proxy": dead}
        with patch.dict(os.environ, environ):
            for name in ("NO_PROXY", "no_proxy"):
                os.environ.pop(name, None)
            with self.assertRaises(urllib.error.URLError):  # what an inherited proxy would do
                urllib.request.build_opener().open(self.fake.origin + "/v1/chat/completions", timeout=3)
            result = self.chat(self.keys())
        self.assertEqual(result[1], "freellmapi")

    def test_versions_without_profiles_fall_back_to_auto(self):
        for status, error in ((400, {"error": {"message": "Profile 'fast' not found. Use 'auto' for the default profile."}}),
                              (400, {"error": {"message": "Unknown profile.", "type": "invalid_request_error", "code": "model_not_found"}}),
                              (404, {"error": {"message": "Model 'auto:fast' is not in the catalog.", "code": "model_not_found"}})):
            with self.subTest(status=status):
                ai_providers.reset()
                self.fake.calls.clear()
                self.fake.routes["/v1/chat/completions"] = lambda body, s=status, e=error: (s, e) if body["model"] == "auto:fast" else completion()
                result = self.chat(self.keys())
                self.assertEqual(result[1:], ("freellmapi", "auto"))
                self.assertEqual([c["body"]["model"] for c in self.fake.calls], ["auto:fast", "auto"])
                self.assertNotIn("/v1/models", [c["path"] for c in self.fake.calls], "a router's models are never pinned")
                self.fake.calls.clear()
                self.chat(self.keys())
                self.assertEqual([c["body"]["model"] for c in self.fake.calls], ["auto"])

    def test_cut_off_answer_is_retried_once_then_the_next_service_answers(self):
        self.fake.routes["/v1/chat/completions"] = completion('{"title": "cut', "length")
        result = self.chat(self.keys(GEMINI_API_KEY=GEMINI_KEY), cloud=GEMINI_ANSWER)
        self.assertEqual(result[1], "gemini")
        self.assertEqual(len(self.fake.calls), 2)
        state = ai_providers._state["freellmapi"]
        self.assertEqual(state["reason"], "bad_response")
        self.assertLessEqual(state["until"] - time.time(), 5.1, "a router is benched only briefly")

    def test_cut_off_tally_is_retried_without_a_bench(self):
        self.fake.routes["/v1/chat/completions"] = (502, {"error": {"message": TALLY % "format_ignored \u00d72",
                                                                      "type": "provider_error", "code": "upstream_failed"}})
        result = self.chat(self.keys(GEMINI_API_KEY=GEMINI_KEY), cloud=GEMINI_ANSWER)
        self.assertEqual(result[1], "gemini")
        self.assertEqual(len(self.fake.calls), 2)
        self.assertEqual(self.provider(self.keys())["state"], "ready")
        # The retry works when FreeLLMAPI picks a model that finishes.
        ai_providers.reset()
        self.fake.calls.clear()
        self.fake.routes["/v1/chat/completions"] = [(502, {"error": {"message": TALLY % "empty_completion \u00d71, format_ignored \u00d71"}}),
                                                    completion()]
        self.assertEqual(self.chat(self.keys())[1], "freellmapi")
        self.assertEqual(len(self.fake.calls), 2)

    def test_other_failures_in_the_tally_are_an_outage(self):
        self.fake.routes["/v1/chat/completions"] = (502, {"error": {"message": TALLY % "format_ignored \u00d71, timeout \u00d71"}})
        result = self.chat(self.keys())
        self.assertEqual(result.code, "unavailable")
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(self.provider(self.keys())["state"], "unavailable")

    def test_no_retry_when_time_is_short(self):
        self.fake.routes["/v1/chat/completions"] = completion('{"title": "cut', "length")
        result = self.chat(self.keys(), deadline=time.monotonic() + 20)
        self.assertEqual(result.code, "request")
        self.assertEqual(len(self.fake.calls), 1)

    def test_patience_bench_and_overall_deadline(self):
        seen = []

        def slow(request, timeout):
            seen.append((urlsplit(request.full_url).hostname, timeout))
            if urlsplit(request.full_url).hostname == "127.0.0.1":
                raise TimeoutError("timed out")
            return GEMINI_ANSWER
        with patch.object(ai_providers, "_urlopen", side_effect=slow):
            result = ai_providers.chat(MESSAGES, keys=self.keys(GEMINI_API_KEY=GEMINI_KEY), deadline=time.monotonic() + 160)
        self.assertEqual(result[1], "gemini")
        self.assertAlmostEqual(seen[0][1], 110, delta=1)
        self.assertLessEqual(seen[1][1], 45)
        state = ai_providers._state["freellmapi"]
        self.assertEqual(state["reason"], "timeout")
        self.assertLessEqual(state["until"] - time.time(), 5.1)
        import server
        self.assertEqual(server.COMPLETION_DEADLINE, 160)

    def test_switched_off_services_are_skipped(self):
        self.fake.routes["/v1/chat/completions"] = completion()
        keys = self.keys(GEMINI_API_KEY=GEMINI_KEY)
        result = self.chat(keys, cloud=GEMINI_ANSWER, disabled=frozenset({"freellmapi"}))
        self.assertEqual(result[1], "gemini")
        self.assertEqual(self.fake.calls, [])
        status = ai_providers.status(keys, {"freellmapi"})
        self.assertEqual([(p["id"], p["enabled"], p["state"]) for p in status["providers"]][:2],
                         [("freellmapi", False, "disabled"), ("gemini", True, "ready")])
        self.assertEqual(ai_providers.usable(keys, {"freellmapi"}), ["gemini"])
        self.assertFalse(ai_providers.status(self.keys(), {"freellmapi"})["ready"])
        result = self.chat(self.keys(), disabled={"freellmapi"})
        self.assertEqual(result.code, "no_provider")

    def test_tokens_in_error_text_are_redacted(self):
        self.fake.routes["/v1/chat/completions"] = (400, {"error": {"message": "Bad request from /v1/t/flmurl_secretToken1234 with "
                                                                              "key freellmapi-0a1b2c3d0a1b2c3d"}})
        self.chat(self.keys())
        detail = ai_providers.details()["freellmapi"]
        self.assertNotIn("secretToken", detail)
        self.assertNotIn("0a1b2c3d0a1b", detail)


class TestButtonTests(FreeLLMAPICase):
    def test_ok(self):
        self.fake.routes["/v1/chat/completions"] = completion('{"ok": true}')
        result = ai_providers.test("freellmapi", self.keys())
        self.assertEqual((result["ok"], result["model"]), (True, "auto:fast"))
        self.assertIsInstance(result["ms"], int)

    def test_not_running(self):
        keys = {"FREELLMAPI_KEY": KEY, "FREELLMAPI_URL": "http://127.0.0.1:%d/v1" % closed_port()}
        result = ai_providers.test("freellmapi", keys)
        self.assertEqual(result, {"ok": False, "kind": "not_running",
                                  "message": "FreeLLMAPI isn't running on this computer. Start it, then choose Test again."})

    def test_no_upstreams(self):
        for code in ("no_providers_configured", "no_upstreams_configured"):
            ai_providers.reset()
            self.fake.routes["/v1/chat/completions"] = (503, {"error": {"message": "No models are enabled/configured to serve this request.",
                                                                          "type": "service_unavailable", "code": code}})
            result = ai_providers.test("freellmapi", self.keys())
            self.assertEqual((result["kind"], result["message"]), ("no_upstreams",
                             "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then choose Test again."))

    def test_key_rejected_benches_and_a_good_test_clears_it(self):
        self.fake.routes["/v1/chat/completions"] = (401, {"error": {"message": "Invalid API key", "type": "authentication_error"}})
        result = ai_providers.test("freellmapi", self.keys())
        self.assertEqual(result, {"ok": False, "kind": "key_rejected",
                                  "message": "FreeLLMAPI didn't accept this key. Copy the whole key and paste it again."})
        self.assertEqual(self.provider(self.keys())["state"], "key_rejected")
        self.fake.routes["/v1/chat/completions"] = completion('{"ok": true}')
        self.assertTrue(ai_providers.test("freellmapi", self.keys())["ok"], "a test ignores the bench")
        self.assertEqual(self.provider(self.keys())["state"], "ready")

    def test_rate_limited_names_the_wait(self):
        self.fake.routes["/v1/chat/completions"] = (429, {"error": {"message": "All models rate-limited"}}, {"Retry-After": "42"})
        result = ai_providers.test("freellmapi", self.keys())
        self.assertEqual(result["kind"], "rate_limited")
        self.assertRegex(result["message"], r"^FreeLLMAPI accepted the key but is busy right now\. "
                                            r"Marteloio will try it again in 4[23] seconds\.$")

    def test_not_configured_and_unknown(self):
        self.assertEqual(ai_providers.test("gemini", {}), {"ok": False, "kind": "not_configured",
                                                           "message": "Add a key for Google Gemini first."})
        with self.assertRaises(ValueError):
            ai_providers.test("mistral", {})

    def test_time_limits(self):
        limits = []

        def record(request, timeout):
            limits.append(timeout)
            raise TimeoutError("timed out")
        with patch.object(ai_providers, "_urlopen", side_effect=record):
            self.assertEqual(ai_providers.test("freellmapi", self.keys())["kind"], "timeout")
            self.assertEqual(ai_providers.test("gemini", {"GEMINI_API_KEY": GEMINI_KEY}),
                             {"ok": False, "kind": "timeout", "message": "Google Gemini didn't answer in time. Try again in a minute."})
        self.assertAlmostEqual(limits[0], 60, delta=1)
        self.assertAlmostEqual(limits[-1], 30, delta=1)

    def test_cloud_messages(self):
        cases = [(urllib.error.HTTPError("x", 403, "", {}, io.BytesIO(b"{}")), "key_rejected",
                  "Groq didn't accept this key. Copy the whole key and paste it again."),
                 (urllib.error.URLError(OSError("network down")), "unavailable",
                  "Groq couldn't be reached. Check your internet connection and try again."),
                 (FakeResponse({"choices": [{"message": {"content": "not json"}}]}), "bad_response",
                  "Groq answered, but not in a way Marteloio can use. Try again later.")]
        for outcome, kind, message in cases:
            ai_providers.reset()
            with self.subTest(kind=kind), patch.object(ai_providers, "_urlopen",
                                                       side_effect=lambda r, t, o=outcome: (_ for _ in ()).throw(o) if isinstance(o, BaseException) else o):
                self.assertEqual(ai_providers.test("groq", {"GROQ_API_KEY": "gsk_fixture1234567"}),
                                 {"ok": False, "kind": kind, "message": message})

    def test_openrouter_privacy_block_says_how_to_fix_it(self):
        body = json.dumps({"error": {"message": "No endpoints found matching your data policy (Free model publication)."}}).encode()
        with patch.object(ai_providers, "_urlopen", side_effect=urllib.error.HTTPError("x", 404, "", {}, io.BytesIO(body))):
            result = ai_providers.test("openrouter", {"OPENROUTER_API_KEY": "sk-or-v1-fixture123456"})
        self.assertEqual(result["kind"], "request_rejected")
        self.assertIn("Settings \u203a Privacy", result["message"])


class DetectTests(unittest.TestCase):
    def test_answers_and_reasons(self):
        fake = FakeUpstream(self)
        for answer, expected in (((200, {"status": "ok", "ready_upstreams": 3}), (True, "")),
                                 ((503, {"status": "unavailable", "reason": "no_upstreams_configured"}), (False, "no_upstreams")),
                                 ((503, {"status": "unavailable", "reason": "all_upstreams_rate_limited"}), (False, "busy")),
                                 ((503, {"status": "unavailable", "reason": "all_upstreams_unhealthy"}), (False, "unhealthy")),
                                 ((503, {"status": "unavailable", "reason": "db_unreachable"}), (False, "unhealthy"))):
            fake.routes["/readyz"] = answer
            with self.subTest(answer=answer), patch.object(ai_providers, "_desktop_port", return_value=None):
                found = ai_providers.detect_freellmapi(fake.origin + "/v1/t/flmurl_x")
            self.assertEqual(found, {"found": True, "ready": expected[0], "base_url": fake.origin + "/v1", "reason": expected[1]})
        self.assertTrue(all(c["authorization"] is None for c in fake.calls), "detection never sends a key")

    def test_probe_order_and_loopback_only(self):
        probed = []
        with patch.object(ai_providers, "_readyz", side_effect=lambda origin, timeout: probed.append((origin, timeout))), \
                patch.object(ai_providers, "_desktop_port", return_value=40123):
            result = ai_providers.detect_freellmapi("http://127.0.0.1:5555/v1/t/flmurl_x")
            self.assertEqual(result, {"found": False, "ready": False, "base_url": "", "reason": "not_running"})
            self.assertEqual([o for o, _ in probed], ["http://127.0.0.1:5555", "http://127.0.0.1:31415",
                                                      "http://127.0.0.1:40123", "http://127.0.0.1:3001"])
            self.assertTrue(all(0 < t <= 1.5 for _, t in probed))
            probed.clear()
            ai_providers.detect_freellmapi("http://192.168.1.20:3001/v1")
            self.assertEqual([o for o, _ in probed][0], "http://127.0.0.1:31415", "a home-network address is not probed")

    def test_total_time_is_bounded(self):
        clock = [100.0]

        def slow(origin, timeout):
            clock[0] += 2
            return None
        with patch.object(ai_providers, "_readyz", side_effect=slow) as probe, \
                patch.object(ai_providers.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(ai_providers, "_desktop_port", return_value=40123):
            ai_providers.detect_freellmapi("http://127.0.0.1:5555/v1")
        self.assertEqual(probe.call_count, 3)

    def test_something_else_on_the_port_is_not_freellmapi(self):
        fake = FakeUpstream(self, {"/readyz": (200, {"hello": "world"})})
        target = FakeUpstream(self, {"/readyz": (200, {"status": "ok"})})
        redirect = FakeUpstream(self, {"/readyz": (302, b"", {"Location": target.origin + "/readyz"})})
        with patch.object(ai_providers, "_desktop_port", return_value=None):
            for origin in (fake.origin, redirect.origin):
                self.assertIsNone(ai_providers._readyz(origin, 1.5))
            self.assertIsNone(ai_providers._readyz("http://127.0.0.1:%d" % closed_port(), 1.5))
        self.assertEqual(target.calls, [], "redirects are not followed")

    def test_desktop_app_port_from_its_config(self):
        folder = tempfile.mkdtemp(prefix="marteloio-appdata-")
        self.addCleanup(shutil.rmtree, folder, True)
        os.makedirs(os.path.join(folder, "FreeLLMAPI"))
        config = os.path.join(folder, "FreeLLMAPI", "config.json")
        with patch.object(ai_providers.os, "name", "nt"):
            for content, expected in (('{"port": 31416, "theme": "dark"}', 31416), ('{"port": 80}', None),
                                      ('{"port": true}', None), ('{"port": "31416"}', None), ("not json", None), ("[]", None)):
                with open(config, "w", encoding="utf-8") as handle:
                    handle.write(content)
                self.assertEqual(ai_providers._desktop_port({"APPDATA": folder}), expected, content)
            self.assertIsNone(ai_providers._desktop_port({}))
        self.assertIsNone(ai_providers._desktop_port({"APPDATA": folder}), "Windows only")


if __name__ == "__main__":
    unittest.main()
