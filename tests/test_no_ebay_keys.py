"""0.4.0: Marteloio asks eBay for nothing and keeps no eBay keys.

Look up and Find keywords are gone. Their routes answer 404, the code names no eBay API
address, and eBay keys saved by an older version are deleted on the first start, as 0.3.0
did with eBay account sign-ins. Temporary files only; no network.
"""
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from fixtures_v020 import DataFolder, RunningApp, fake_dpapi

ROOT = Path(__file__).resolve().parents[1]
REMOVED_ROUTES = [("GET", "/ebay/search?keywords=canon+ae-1"), ("GET", "/ebay/search?gtin=012345678905"),
                  ("GET", "/ebay/reference?item_id=v1%7C1%7C0"), ("POST", "/settings/ebay"),
                  # removed in 0.3.0, still gone
                  ("GET", "/ebay/userstats"), ("POST", "/ebay/token-user")]
OLD_STORE = {"ebay_client_id": "Seller-App-PRD-fixture", "ebay_client_secret": "PRD-secret-fixture",
             "provider_keys": {"GROQ_API_KEY": "gsk_keep"}}


def quiet(function):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        function()
    return out.getvalue()


class NoEbayRequestsTests(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)

    def test_the_look_up_and_ebay_key_routes_are_gone(self):
        app = RunningApp(self)
        for method, path in REMOVED_ROUTES:
            with self.subTest(path=path):
                status, data = app.request(method, path, body={"client_id": "x"} if method == "POST" else None)
                self.assertEqual((status, data.get("kind")), (404, "not_found"))

    def test_settings_and_health_say_nothing_about_ebay(self):
        app = RunningApp(self)
        status, settings = app.request("GET", "/settings")
        self.assertEqual(status, 200)
        self.assertNotIn("ebay", settings)
        status, health = app.request("GET", "/health", token=False)
        self.assertEqual(status, 200)
        self.assertNotIn("ebay_configured", health)

    def test_the_code_names_no_ebay_address_key_or_search(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        for gone in ("api.ebay.com", "buy/browse", "oauth2/token", "client_credentials", "X-EBAY-C-MARKETPLACE-ID",
                     "ebay_not_configured", "ebay_auth", "ebay_unavailable"):
            self.assertNotIn(gone, source, gone)
        for name in ("browse_search", "browse_reference", "try_search", "app_token_fresh", "normalize_gtin", "get_ebay_cred",
                     "set_ebay_creds", "client_id", "client_secret", "http_get", "http_post", "outbound_request",
                     "migrate_secrets", "EBAY_MESSAGES", "OAUTH_TOKEN_URL", "BROWSE_URL"):
            self.assertFalse(hasattr(server, name), name)
        page = (ROOT / "index.html").read_text(encoding="utf-8") + (ROOT / "listing-core.js").read_text(encoding="utf-8")
        for gone in ("/ebay/search", "/ebay/reference", "/settings/ebay", "api.ebay.com", "developer.ebay.com", 'id="lookupBtn"', 'id="mineBtn"'):
            self.assertNotIn(gone, page, gone)
        self.assertIn("https://www.ebay.com/sch/i.html?_nkw=", page)  # the Search eBay link, opened by the seller's browser


class ForgetEbayKeysTests(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)

    def test_keys_saved_by_an_older_version_leave_the_store_and_ai_keys_stay(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets(dict(OLD_STORE)))
            logged = quiet(server.forget_ebay_keys)
            store = server.load_secrets()
            again = quiet(server.forget_ebay_keys)
        self.assertEqual(store, {"provider_keys": {"GROQ_API_KEY": "gsk_keep"}})
        self.assertIn("removed the eBay keys", logged)
        for secret in ("Seller-App-PRD-fixture", "PRD-secret-fixture", "gsk_keep"):
            self.assertNotIn(secret, logged)
        self.assertNotIn(b"PRD-secret-fixture", Path(server.SECRETS_PATH).read_bytes())
        self.assertEqual(again, "")

    def test_a_store_without_ebay_keys_is_not_rewritten(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"provider_keys": {"GROQ_API_KEY": "gsk_keep"}}))
            before = Path(server.SECRETS_PATH).read_bytes()
            with patch.object(server, "atomic_write", side_effect=AssertionError("no write expected")):
                logged = quiet(server.forget_ebay_keys)
            self.assertEqual((logged, Path(server.SECRETS_PATH).read_bytes()), ("", before))

    def test_without_encrypted_storage_the_keys_leave_the_env_file_and_other_lines_stay(self):
        Path(server.ENV_PATH).write_text("# my keys\nEBAY_CLIENT_ID=Seller-App-PRD-fixture\nGROQ_API_KEY=gsk_keep\nEBAY_CLIENT_SECRET=PRD-secret-fixture\nPORT=8080\n")
        with patch.dict(os.environ, {"EBAY_CLIENT_ID": "Seller-App-PRD-fixture", "EBAY_CLIENT_SECRET": "PRD-secret-fixture"}), \
                patch.object(server, "dpapi_available", return_value=False):
            logged = quiet(server.forget_ebay_keys)
            self.assertNotIn("EBAY_CLIENT_ID", os.environ)
            self.assertNotIn("EBAY_CLIENT_SECRET", os.environ)
        self.assertEqual(Path(server.ENV_PATH).read_text(), "# my keys\nGROQ_API_KEY=gsk_keep\nPORT=8080\n")
        self.assertIn("removed the eBay keys", logged)
        self.assertNotIn("PRD-secret-fixture", logged)

    def test_an_env_file_without_ebay_keys_is_left_exactly_as_it_is(self):
        text = "GROQ_API_KEY=gsk_keep\n\n# note\n"
        Path(server.ENV_PATH).write_text(text)
        with patch.object(server, "dpapi_available", return_value=False), \
                patch.object(server, "atomic_write", side_effect=AssertionError("no write expected")):
            logged = quiet(server.forget_ebay_keys)
        self.assertEqual((logged, Path(server.ENV_PATH).read_text()), ("", text))

    def test_a_failed_store_write_is_reported_as_a_retry_and_changes_nothing(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets(dict(OLD_STORE)))
            before = Path(server.SECRETS_PATH).read_bytes()
            with patch.object(server, "atomic_write", side_effect=OSError("disk full")):
                logged = quiet(server.forget_ebay_keys)
            self.assertIn("will retry next start", logged)
            self.assertEqual(Path(server.SECRETS_PATH).read_bytes(), before)

    def test_an_unreadable_store_is_never_rewritten(self):
        with fake_dpapi():
            Path(server.SECRETS_PATH).write_bytes(b"not a store")
            logged = quiet(server.forget_ebay_keys)
            self.assertEqual(Path(server.SECRETS_PATH).read_bytes(), b"not a store")
        self.assertEqual(self.data.names(), [".marteloio-secrets.enc"])
        self.assertIn("left as they are", logged)

    def test_keys_in_the_pre_rename_store_are_removed_and_ai_keys_move(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets(dict(OLD_STORE)))
            os.replace(server.SECRETS_PATH, server.LEGACY_SECRETS_PATH)
            quiet(server.forget_ebay_keys)
            self.assertEqual(server.load_secrets(), {"provider_keys": {"GROQ_API_KEY": "gsk_keep"}})
        self.assertNotIn(b"PRD-secret-fixture", Path(server.secrets_read_path()).read_bytes())

    def test_keys_copied_in_while_running_go_with_the_next_save(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets(dict(OLD_STORE)))
            with contextlib.redirect_stderr(io.StringIO()):
                server.save_provider_settings({"GEMINI_API_KEY": "AIzaSyFixtureGeminiKey0123456789a1B2"})
            store = server.load_secrets()
        self.assertNotIn("ebay_client_id", store)
        self.assertNotIn("ebay_client_secret", store)
        self.assertEqual(store["provider_keys"]["GROQ_API_KEY"], "gsk_keep")

    def test_startup_forgets_the_keys_before_serving(self):
        calls = []
        with patch.object(server, "load_env"), patch.object(server, "bind_server") as bind, \
                patch.object(server, "forget_saved_sign_in", side_effect=lambda: calls.append("sign-in")), \
                patch.object(server, "forget_ebay_keys", side_effect=lambda: calls.append("keys")), \
                patch.object(server, "report_unreadable_store", side_effect=lambda: calls.append("report")):
            bind.return_value.serve_forever.side_effect = lambda: calls.append("serve")
            quiet(server.main)
        self.assertEqual(calls, ["sign-in", "keys", "report", "serve"])


if __name__ == "__main__":
    unittest.main()
