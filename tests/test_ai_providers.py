"""In-house provider fallback: every HTTP call is mocked, no real provider is contacted."""
import io
import json
from pathlib import Path
import sys
import time
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_providers

MESSAGES = [{"role": "user", "content": "Fixture"}]
ALL_KEYS = {"GEMINI_API_KEY": "AIzaFixtureGeminiKey1234567890abc",
            "GROQ_API_KEY": "gsk_fixtureGroqKey1234567890abcdef",
            "OPENROUTER_API_KEY": "sk-or-v1-fixtureOpenRouterKey1234567890abcdef"}


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode() if not isinstance(body, bytes) else body

    def read(self, limit=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def reply(text="{\"ok\": true}"):
    # Answers must be JSON (a cut-off or non-JSON answer moves on): wrap plain words.
    try:
        json.loads(text)
    except ValueError:
        text = json.dumps({"answer": text})
    return FakeResponse({"choices": [{"message": {"role": "assistant", "content": text}}]})


def said(text):
    """The plain words a reply() fixture wrapped, or the answer as sent."""
    try:
        data = json.loads(text)
    except ValueError:
        return text
    return data["answer"] if isinstance(data, dict) and set(data) == {"answer"} else text


def http_error(url, code, body=b"{}", headers=None):
    return urllib.error.HTTPError(url, code, "fixture", headers or {}, io.BytesIO(body))


class Upstream:
    """Routes mocked requests by (provider host, model) to queued outcomes."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, request, timeout):
        url = request.full_url
        payload = json.loads(request.data) if request.data else {}
        self.calls.append((url, payload.get("model"), payload, request.get_header("Authorization"), timeout))
        host = next(name for name, spec in ai_providers.PROVIDERS.items() if url.startswith(spec["base"]))
        outcome = self.routes.get((host, payload.get("model")), self.routes.get(host))
        if isinstance(outcome, list):
            outcome = outcome.pop(0)
        if callable(outcome) and not isinstance(outcome, FakeResponse):
            outcome = outcome(url)
        if isinstance(outcome, BaseException):
            raise outcome
        if outcome is None:
            raise AssertionError("Unexpected request to %s" % url)
        return outcome

    def hosts(self):
        return [next(n for n, s in ai_providers.PROVIDERS.items() if url.startswith(s["base"])) for url, *_ in self.calls]


class ProviderTests(unittest.TestCase):
    def setUp(self):
        with ai_providers._LOCK:
            for name in ai_providers.ORDER:
                ai_providers._state[name] = {}
            ai_providers._resolved.clear()
            ai_providers._details.clear()
            ai_providers._fingerprints.clear()

    def run_chat(self, routes, keys=ALL_KEYS, **kwargs):
        upstream = Upstream(routes)
        with patch.object(ai_providers, "_urlopen", side_effect=upstream):
            try:
                text, name, model = ai_providers.chat(MESSAGES, keys=keys, **kwargs)
                result = (said(text), name, model)
            except ai_providers.NoProvider as failure:
                result = failure
        return result, upstream

    def test_requested_answer_budget_reaches_the_provider(self):
        result, upstream = self.run_chat({"gemini": reply("short")}, max_tokens=800)
        self.assertEqual(result, ("short", "gemini", "gemini-flash-latest"))
        self.assertEqual(upstream.calls[0][2]["max_tokens"], 800)

    def test_openrouter_gets_a_reasoning_floor_for_short_requests(self):
        # The free router can pick a reasoning model that answers empty at 800 tokens.
        result, upstream = self.run_chat({"openrouter": reply("o")}, keys={"OPENROUTER_API_KEY": ALL_KEYS["OPENROUTER_API_KEY"]}, max_tokens=800)
        self.assertEqual(result[:2], ("o", "openrouter"))
        self.assertEqual(upstream.calls[0][2]["max_tokens"], 2000)
        result, upstream = self.run_chat({"openrouter": reply("o")}, keys={"OPENROUTER_API_KEY": ALL_KEYS["OPENROUTER_API_KEY"]}, max_tokens=3000)
        self.assertEqual(upstream.calls[0][2]["max_tokens"], 3000)

    def provider(self, keys, name):
        return next(p for p in ai_providers.status(keys)["providers"] if p["id"] == name)

    def test_fallback_order_is_freellmapi_gemini_groq_openrouter(self):
        self.assertEqual(ai_providers.ORDER, ("freellmapi", "gemini", "groq", "openrouter"))
        result, upstream = self.run_chat({"gemini": reply("gemini")})
        self.assertEqual(result, ("gemini", "gemini", "gemini-flash-latest"))
        payload = upstream.calls[0][2]
        self.assertEqual(payload["reasoning_effort"], "low")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["max_tokens"], 3000)
        self.assertEqual(upstream.calls[0][3], "Bearer " + ALL_KEYS["GEMINI_API_KEY"])
        self.assertEqual(ai_providers.PROVIDERS["gemini"]["fallbacks"], ["gemini-3.6-flash"])
        # Only configured providers are asked, in order.
        result, upstream = self.run_chat({"groq": reply("groq")}, keys={"GROQ_API_KEY": ALL_KEYS["GROQ_API_KEY"]})
        self.assertEqual(result, ("groq", "groq", "openai/gpt-oss-120b"))
        payload = upstream.calls[0][2]
        self.assertEqual(payload["reasoning_effort"], "low")
        self.assertIs(payload["include_reasoning"], False)
        key = ALL_KEYS["OPENROUTER_API_KEY"]
        result, upstream = self.run_chat({"openrouter": reply("free")}, keys={"OPENROUTER_API_KEY": key})
        self.assertEqual(result, ("free", "openrouter", "openrouter/free"))
        self.assertTrue(upstream.calls[0][0].startswith("https://openrouter.ai/api/v1/chat/completions"))
        self.assertEqual(upstream.calls[0][2]["reasoning"], {"effort": "low", "exclude": True})
        self.assertNotIn("reasoning_effort", upstream.calls[0][2])
        self.assertEqual(upstream.calls[0][3], "Bearer " + key)
        self.assertEqual(ai_providers.PROVIDERS["openrouter"].get("fallbacks", []), [])

    def test_legacy_mistral_key_is_ignored(self):
        legacy = "MistralLegacyFixtureKey1234567890abcdef"
        self.assertNotIn("mistral", ai_providers.PROVIDERS)
        result, upstream = self.run_chat({}, keys={"MISTRAL_API_KEY": legacy})
        self.assertEqual((result.code, upstream.calls), ("no_provider", []))
        keys = {"MISTRAL_API_KEY": legacy, "GEMINI_API_KEY": ALL_KEYS["GEMINI_API_KEY"]}
        result, upstream = self.run_chat({"gemini": http_error("x", 503)}, keys=keys)
        self.assertEqual(upstream.hosts(), ["gemini"])
        self.assertNotIn(legacy, json.dumps([c[2] for c in upstream.calls] + [c[3] for c in upstream.calls]))
        status = json.dumps(ai_providers.status(keys))
        self.assertNotIn("mistral", status.lower())
        self.assertNotIn(legacy[-4:], status)

    def test_every_request_goes_to_a_public_https_provider(self):
        result, upstream = self.run_chat({"gemini": http_error("x", 503), "groq": http_error("g", 500),
                                          "openrouter": reply()})
        self.assertEqual(result[1], "openrouter")
        self.assertEqual(upstream.hosts(), ["gemini", "groq", "openrouter"])
        for url, *_ in upstream.calls:
            self.assertTrue(url.startswith("https://"), url)
            self.assertNotIn("127.0.0.1", url)
            self.assertNotIn("localhost", url)
            self.assertNotIn(":4000", url)

    def test_rate_limit_benches_with_retry_after_and_falls_through(self):
        result, upstream = self.run_chat({"gemini": http_error("x", 429, headers={"Retry-After": "120"}),
                                          "groq": reply("groq")})
        self.assertEqual(result[:2], ("groq", "groq"))
        status = ai_providers.status(ALL_KEYS)
        gemini = self.provider(ALL_KEYS, "gemini")
        self.assertEqual((gemini["id"], gemini["state"], gemini["configured"]), ("gemini", "rate_limited", True))
        self.assertTrue(115 <= gemini["retry_in"] <= 121)
        self.assertTrue(status["ready"])
        # The benched provider is skipped on the next call.
        result, upstream = self.run_chat({"groq": reply("again")})
        self.assertEqual(upstream.hosts(), ["groq"])

    def test_retry_after_is_clamped(self):
        for raw, low, high in (("1", 4, 6), ("999999", 3595, 3601), ("junk", 59, 61), (None, 59, 61)):
            self.setUp()
            self.run_chat({"groq": http_error("g", 429, headers={"Retry-After": raw} if raw else {})},
                          keys={"GROQ_API_KEY": "gsk_fixture"})
            wait = ai_providers._state["groq"]["until"] - time.time()
            self.assertTrue(low <= wait <= high, (raw, wait))

    def test_all_rate_limited_reports_soonest_retry(self):
        result, _ = self.run_chat({"gemini": http_error("x", 429, headers={"Retry-After": "300"}),
                                   "groq": http_error("g", 429, headers={"Retry-After": "40"}),
                                   "openrouter": http_error("o", 429, headers={"Retry-After": "90"})})
        self.assertIsInstance(result, ai_providers.NoProvider)
        self.assertEqual(result.code, "rate_limited")
        self.assertTrue(39 <= result.retry_after <= 41)
        status = ai_providers.status(ALL_KEYS)
        self.assertFalse(status["ready"])
        self.assertTrue(39 <= status["retry_in"] <= 41)

    def test_key_rejected_stays_benched_until_key_changes(self):
        keys = {"GROQ_API_KEY": "gsk_rejected_fixture"}
        result, _ = self.run_chat({"groq": http_error("g", 401)}, keys=keys)
        self.assertEqual(result.code, "key_rejected")
        status = ai_providers.status(keys)
        groq = self.provider(keys, "groq")
        self.assertEqual((groq["state"], groq["retry_in"], status["retry_in"]), ("key_rejected", 0, 0))
        result, upstream = self.run_chat({}, keys=keys)
        self.assertEqual((result.code, upstream.calls), ("key_rejected", []))
        # A changed key clears the bench immediately.
        result, upstream = self.run_chat({"groq": reply("fresh")}, keys={"GROQ_API_KEY": "gsk_replacement_fixture"})
        self.assertEqual(result[0], "fresh")

    def test_reset_clears_named_provider_only(self):
        self.run_chat({"gemini": http_error("x", 403), "groq": http_error("g", 429), "openrouter": reply()})
        ai_providers.reset({"GEMINI_API_KEY"})
        states = {p["id"]: p["state"] for p in ai_providers.status(ALL_KEYS)["providers"]}
        self.assertEqual(states, {"freellmapi": "off", "gemini": "ready", "groq": "rate_limited", "openrouter": "ready"})

    def test_retired_model_walks_fallbacks_then_account_list(self):
        retired = http_error("g", 404, b'{"error": {"message": "The model does not exist"}}')
        listed = FakeResponse({"data": [{"id": "whisper-large-v3"}, {"id": "qwen3-32b-instruct"},
                                        {"id": "llama-4-maverick-17b-128e-instruct"}]})
        routes = {("groq", "openai/gpt-oss-120b"): retired,
                  ("groq", "openai/gpt-oss-20b"): http_error("g", 400, b'{"error": {"message": "model has been decommissioned and is no longer supported"}}'),
                  ("groq", "llama-3.3-70b-versatile"): http_error("g", 410),
                  ("groq", None): listed,
                  ("groq", "llama-4-maverick-17b-128e-instruct"): reply("walked")}
        result, upstream = self.run_chat(routes, keys={"GROQ_API_KEY": "gsk_fixture"})
        self.assertEqual(result, ("walked", "groq", "llama-4-maverick-17b-128e-instruct"))
        self.assertEqual([c[1] for c in upstream.calls],
                         ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", None,
                          "llama-4-maverick-17b-128e-instruct"])
        self.assertTrue(upstream.calls[3][0].endswith("/models"))
        self.assertIn("using llama-4-maverick", ai_providers.details()["groq"])
        # The replacement is remembered for the session.
        result, upstream = self.run_chat({"groq": reply("again")}, keys={"GROQ_API_KEY": "gsk_fixture"})
        self.assertEqual([c[1] for c in upstream.calls], ["llama-4-maverick-17b-128e-instruct"])
        self.assertEqual(self.provider({"GROQ_API_KEY": "gsk_fixture"}, "groq")["model"],
                         "llama-4-maverick-17b-128e-instruct")

    def test_model_walk_is_bounded(self):
        many = FakeResponse({"data": [{"id": "chat-%d" % i} for i in range(30)]})
        upstream_routes = {"groq": lambda url: many if url.endswith("/models") else http_error(url, 404)}
        result, upstream = self.run_chat(upstream_routes, keys={"GROQ_API_KEY": "gsk_fixture"})
        self.assertEqual(result.code, "unavailable")
        completions = [c for c in upstream.calls if c[0].endswith("/chat/completions")]
        self.assertEqual(len(completions), ai_providers._MAX_MODEL_TRIES)

    def test_non_retirement_400_retries_once_without_response_format(self):
        routes = {"openrouter": [http_error("o", 400, b'{"message": "response_format is not supported"}'), reply("plain")]}
        result, upstream = self.run_chat(routes, keys={"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
        self.assertEqual(result[0], "plain")
        self.assertIn("response_format", upstream.calls[0][2])
        self.assertNotIn("response_format", upstream.calls[1][2])

    def test_empty_content_moves_to_next_provider(self):
        empty = FakeResponse({"choices": [{"message": {"content": "", "reasoning": "thinking..."}}]})
        result, upstream = self.run_chat({"gemini": empty, "groq": FakeResponse(b"not json"), "openrouter": reply("o")})
        self.assertEqual(result[:2], ("o", "openrouter"))
        states = {p["id"]: p["state"] for p in ai_providers.status(ALL_KEYS)["providers"]}
        self.assertEqual(states, {"freellmapi": "off", "gemini": "bad_response", "groq": "bad_response", "openrouter": "ready"})
        self.assertIn("reasoning", ai_providers.details()["gemini"])

    def test_deadline_bounds_the_whole_call(self):
        def slow(url):
            clock[0] += 50
            return urllib.error.URLError("timed out")
        clock = [1000.0]
        with patch.object(ai_providers.time, "monotonic", side_effect=lambda: clock[0]):
            result, upstream = self.run_chat({"gemini": slow, "groq": slow, "openrouter": slow}, deadline=1090)
        self.assertEqual(result.code, "timeout")
        self.assertEqual(upstream.hosts(), ["gemini", "groq"])
        self.assertLessEqual(upstream.calls[0][4], ai_providers._TIMEOUT)
        self.assertLessEqual(upstream.calls[1][4], 40)

    def test_keys_are_redacted_from_stored_details(self):
        key = ALL_KEYS["OPENROUTER_API_KEY"]
        other = "sk-or-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9"
        body = json.dumps({"error": {"message": "Invalid key %s for gsk_otherLeakedKey123456 and AIzaSyLeakedKey12345678 and %s" % (key, other)}}).encode()
        result, _ = self.run_chat({"openrouter": http_error("o", 401, body)}, keys={"OPENROUTER_API_KEY": key})
        self.assertEqual(result.code, "key_rejected")
        detail = ai_providers.details()["openrouter"]
        self.assertIn("Invalid key", detail)
        for secret in (key, other, "sk-or-v1-0a1b", "gsk_otherLeakedKey123456", "AIzaSyLeakedKey12345678"):
            self.assertNotIn(secret, detail)
        # An OpenRouter-style key is redacted even when it is not the key in use.
        self.assertNotIn("0a1b2c3d", ai_providers._redact("leaked %s here" % other, ""))
        self.assertNotIn("sk-or-v1-short1234", ai_providers._redact("leaked sk-or-v1-short1234", ""))
        status = ai_providers.status({"OPENROUTER_API_KEY": key})
        self.assertNotIn(key[:-4], json.dumps(status))
        # Only the last four characters are shown, so the seller can tell keys apart.
        self.assertEqual(self.provider({"OPENROUTER_API_KEY": key}, "openrouter")["key_hint"], key[-4:])

    def test_no_keys_is_no_provider_without_requests(self):
        for keys in ({}, {"GROQ_API_KEY": "", "OPENROUTER_API_KEY": "   "}, None):
            result, upstream = self.run_chat({}, keys=keys)
            self.assertEqual((result.code, upstream.calls), ("no_provider", []))
        status = ai_providers.status({})
        self.assertEqual(status["ready"], False)
        self.assertEqual([p["state"] for p in status["providers"]], ["off", "off", "off", "off"])
        fields = {"id", "label", "configured", "enabled", "state", "retry_in", "model", "key_hint", "checked"}
        self.assertEqual(set(status["providers"][1]), fields)
        self.assertEqual(set(status["providers"][0]), fields | {"base_url"})

    def test_invalid_key_characters_are_never_sent(self):
        result, upstream = self.run_chat({}, keys={"GROQ_API_KEY": "has space"})
        self.assertEqual((result.code, upstream.calls), ("key_rejected", []))

    def test_mixed_failures_map_to_one_outcome(self):
        result, _ = self.run_chat({"gemini": http_error("x", 503), "groq": http_error("g", 429), "openrouter": http_error("o", 401)})
        self.assertEqual(result.code, "unavailable")
        self.assertGreaterEqual(result.retry_after, 1)
        self.setUp()
        result, _ = self.run_chat({"gemini": http_error("x", 413), "groq": http_error("g", 401), "openrouter": http_error("o", 401)})
        self.assertEqual(result.code, "request")

    def test_redirects_are_not_followed(self):
        self.assertIsNone(ai_providers._NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere"))


if __name__ == "__main__":
    unittest.main()
