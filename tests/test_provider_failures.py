"""Provider failure handling without making provider requests."""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ProviderFailureTests(unittest.TestCase):
    def test_seller_stats_failure_does_not_expose_upstream_exception(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_json = Mock()
        with patch.object(server, 'user_token_fresh', return_value={'access_token': 'fixture'}), patch.object(server, 'trading_get_user', side_effect=RuntimeError('PRIVATE-UPSTREAM-FIXTURE')):
            handler.handle_userstats()
        error, status = handler.send_json.call_args.args
        self.assertEqual(status, 502)
        self.assertNotIn('PRIVATE', str(error))
        self.assertIn('statistics', error['error'])

    def completion(self, keys=None, chat=None, body=None):
        handler = server.Handler.__new__(server.Handler)
        handler.read_json = lambda: body or {"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}]}
        handler.send_json = Mock()
        keys = {"GROQ_API_KEY": "fixture-key"} if keys is None else keys
        with patch.object(server, "effective_provider_environment", return_value=keys), \
                patch.object(server.ai_providers, "chat", side_effect=chat) as call:
            handler.handle_completion()
        return handler.send_json.call_args.args, call

    def test_busy_errors_keep_status_and_safe_guidance(self):
        for reason, code in (("rate_limited", 429), ("unavailable", 503)):
            (error, status), _ = self.completion(chat=server.ai_providers.NoProvider(reason, 45))
            self.assertEqual(status, code)
            self.assertEqual(error["kind"], "provider_busy")
            self.assertEqual(error["retry_after"], 45)
            self.assertIn("draft is safe", error["error"])
            self.assertNotIn("keys", error["error"])

    def test_every_failure_maps_to_a_safe_shape(self):
        expected = {"key_rejected": (502, "provider_auth"), "timeout": (504, "provider_timeout"),
                    "request": (502, "provider_request"), "no_provider": (503, "no_provider")}
        for reason, (code, kind) in expected.items():
            (error, status), _ = self.completion(chat=server.ai_providers.NoProvider(reason))
            self.assertEqual((status, error["kind"]), (code, kind))
            self.assertNotIn("fixture-key", json.dumps(error))

    def test_retry_hint_is_bounded(self):
        for raw, expected in [(999999, 3600), (-1, 1), ("invalid", 30), (None, 30), (10 ** 400, 3600)]:
            self.assertEqual(server.provider_failure("rate_limited", raw)[1]["retry_after"], expected)

    def test_authentication_has_distinct_guidance(self):
        status, error = server.provider_failure("key_rejected")
        self.assertEqual(status, 502)
        self.assertEqual(error["kind"], "provider_auth")
        self.assertIn("Settings", error["error"])

    def test_bad_request_has_distinct_guidance(self):
        self.assertEqual(server.provider_failure("request")[1]["kind"], "provider_request")

    def test_success_keeps_the_frontend_contract(self):
        (result,), call = self.completion(
            chat=lambda *a, **k: ('{"title": "x"}', "openrouter", "openrouter/free"),
            body={"model": "listing-text", "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}],
                  "temperature": 7, "fallbacks": [{"listing-text": ["untrusted-client-model"]}]})
        self.assertEqual(result, {"model": "openrouter/openrouter/free", "provider": "openrouter",
                                  "choices": [{"message": {"role": "assistant", "content": '{"title": "x"}'}}]})
        self.assertEqual(call.call_args.args[0], [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}])
        kwargs = call.call_args.kwargs
        self.assertEqual(kwargs["keys"], {"GROQ_API_KEY": "fixture-key"})
        self.assertEqual((kwargs["temperature"], kwargs["max_tokens"], kwargs["json_mode"]), (1.0, 3000, True))
        self.assertLessEqual(kwargs["deadline"] - server.time.monotonic(), server.COMPLETION_DEADLINE)
        self.assertNotIn("fallbacks", kwargs)

    def test_optional_max_tokens_is_passed_through_and_defaults_to_full_budget(self):
        ok = lambda *a, **k: ('{"title": "x"}', "groq", "fixture-model")
        for sent, expected in ((None, 3000), (800, 800), (64, 64), (3000, 3000)):
            body = {"model": "listing-text", "messages": [{"role": "user", "content": "U"}]}
            if sent is not None:
                body["max_tokens"] = sent
            with self.subTest(sent=sent):
                (result,), call = self.completion(chat=ok, body=body)
                self.assertEqual(call.call_args.kwargs["max_tokens"], expected)
                self.assertEqual(result["choices"][0]["message"]["content"], '{"title": "x"}')

    def test_invalid_max_tokens_never_reaches_provider(self):
        for value in (63, 3001, 0, -5, 800.0, "800", True, None, [800], 10 ** 400):
            body = {"model": "listing-text", "messages": [{"role": "user", "content": "U"}], "max_tokens": value}
            with self.subTest(value=value):
                handler = server.Handler.__new__(server.Handler)
                handler.read_json = lambda body=body: body
                handler.send_json = Mock()
                with patch.object(server, "effective_provider_environment", return_value={"GROQ_API_KEY": "fixture-key"}), \
                        patch.object(server.ai_providers, "chat") as call:
                    with self.assertRaisesRegex(ValueError, "Invalid max_tokens"):
                        handler.handle_completion()
                call.assert_not_called()

    def test_no_configured_keys_skips_provider_request(self):
        for keys in ({}, {"GROQ_API_KEY": "  ", "GEMINI_API_KEY": ""}):
            (error, status), call = self.completion(keys=keys)
            call.assert_not_called()
            self.assertEqual(status, 503)
            self.assertEqual(error, {"error": "Connect an AI service first. It takes about 2 minutes with a free Google key.",
                                     "kind": "no_provider"})

    def test_unreadable_encrypted_store_is_a_503_without_provider_request(self):
        handler = server.Handler.__new__(server.Handler)
        handler.read_json = lambda: {"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}]}
        handler.send_json = Mock()
        with patch.object(server, "load_secrets", side_effect=OSError("fixture")), \
                patch.object(server.ai_providers, "chat") as call:
            handler.handle_completion()
        call.assert_not_called()
        error, status = handler.send_json.call_args.args
        self.assertEqual(status, 503)
        self.assertEqual(error["error"], server.PROVIDER_STORE_ERROR)

    def test_effective_environment_uses_encrypted_values_and_removals(self):
        with patch.dict(server.os.environ, {"GROQ_API_KEY": "inherited-fixture"}, clear=True), \
                patch.object(server, "read_env", return_value={"GEMINI_API_KEY": "plain-fixture"}), \
                patch.object(server, "load_secrets", return_value={"provider_keys": {"GROQ_API_KEY": "", "OPENROUTER_API_KEY": "encrypted-fixture"}}):
            env = server.effective_provider_environment()
        self.assertEqual((env["GROQ_API_KEY"], env["GEMINI_API_KEY"], env["OPENROUTER_API_KEY"]),
                         ("", "plain-fixture", "encrypted-fixture"))

    def test_legacy_mistral_key_is_ignored_everywhere(self):
        legacy = {"provider_keys": {"MISTRAL_API_KEY": "encrypted-mistral-fixture"}}
        with patch.dict(server.os.environ, {"MISTRAL_API_KEY": "inherited-mistral-fixture"}, clear=True), \
                patch.object(server, "read_env", return_value={"MISTRAL_API_KEY": "plain-mistral-fixture"}), \
                patch.object(server, "load_secrets", return_value=legacy), \
                patch.object(server, "get_ebay_cred", return_value=""):
            env = server.effective_provider_environment()
            self.assertNotEqual(env.get("MISTRAL_API_KEY"), "encrypted-mistral-fixture")
            # Generation is not attempted with only a Mistral key.
            handler = server.Handler.__new__(server.Handler)
            handler.read_json = lambda: {"model": "listing-text", "messages": [{"role": "user", "content": "Fixture"}]}
            handler.send_json = Mock()
            with patch.object(server.ai_providers, "chat") as call:
                handler.handle_completion()
            call.assert_not_called()
            error, status = handler.send_json.call_args.args
            self.assertEqual((status, error["kind"]), (503, "no_provider"))
            # Settings neither shows it nor reports it as plaintext.
            handler.send_json = Mock()
            handler.handle_settings_get()
            shown = handler.send_json.call_args.args[0]
            self.assertNotIn("mistral", json.dumps(shown).lower())
            self.assertIs(shown["provider_plaintext_present"], False)
            # And it cannot be saved through Settings any more.
            handler.read_json = lambda: {"mistral_api_key": "new-mistral-fixture"}
            handler.send_json = Mock()
            with patch.object(server, "save_provider_settings") as write:
                handler.handle_settings_post()
            write.assert_not_called()
            self.assertEqual(handler.send_json.call_args.args[1], 400)

    def test_removing_one_provider_clears_only_that_environment_key(self):
        handler = server.Handler.__new__(server.Handler)
        handler.read_json = lambda: {'remove_keys': ['groq_api_key']}
        handler.send_json = Mock()
        with patch.dict(server.os.environ, {'GROQ_API_KEY': 'old-fixture', 'GEMINI_API_KEY': 'keep-fixture'}, clear=True), patch.object(server, 'save_provider_settings', return_value={'encrypted': False, 'cleanup_pending': False}) as write, patch.object(server.ai_providers, 'reset') as reset:
            handler.handle_settings_post()
            write.assert_called_once_with({'GROQ_API_KEY': ''})
            self.assertFalse(server.os.environ['GROQ_API_KEY'])
            self.assertTrue(server.os.environ['GEMINI_API_KEY'] == 'keep-fixture')
            reset.assert_called_once_with({'GROQ_API_KEY'})
        self.assertEqual(handler.send_json.call_args.args[0], {
            'saved': ['GROQ_API_KEY'], 'applied': True, 'cleanup_pending': False,
            'message': 'Provider settings saved. New generations use them right away.'})

    def test_cleanup_pending_keeps_its_warning(self):
        handler = server.Handler.__new__(server.Handler)
        handler.read_json = lambda: {'openrouter_api_key': 'new-fixture'}
        handler.send_json = Mock()
        with patch.dict(server.os.environ, {}, clear=True), patch.object(server, 'save_provider_settings', return_value={'encrypted': True, 'cleanup_pending': True}):
            handler.handle_settings_post()
        result = handler.send_json.call_args.args[0]
        self.assertTrue(result['applied'] and result['cleanup_pending'])
        self.assertIn('could not be removed from .env', result['message'])
        self.assertNotIn('new-fixture', json.dumps(result))

    def test_invalid_or_conflicting_key_removal_never_writes(self):
        for body in [{'remove_keys': 'groq_api_key'}, {'remove_keys': ['unknown']},
                     {'remove_keys': [{}]}, {'remove_keys': ['groq_api_key'], 'groq_api_key': 'new-fixture'}]:
            handler = server.Handler.__new__(server.Handler)
            handler.read_json = lambda: body
            with patch.object(server, 'save_provider_settings') as write:
                with self.assertRaises(ValueError):
                    handler.handle_settings_post()
                write.assert_not_called()

    def test_settings_show_inherited_provider_presence_and_empty_file_override(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_json = Mock()
        with patch.dict(server.os.environ, {'GROQ_API_KEY': 'fixture-inherited-private', 'GEMINI_API_KEY': 'fixture-disabled'}, clear=True), patch.object(server, 'read_env', return_value={'GEMINI_API_KEY': ''}), patch.object(server, 'get_ebay_cred', return_value=''), patch.object(server, 'load_secrets', return_value={}):
            handler.handle_settings_get()
        result = handler.send_json.call_args.args[0]
        self.assertTrue(result['groq']['set'])
        self.assertFalse(result['gemini']['set'])
        self.assertNotIn('fixture-inherited-private', json.dumps(result))


if __name__ == "__main__":
    unittest.main()
