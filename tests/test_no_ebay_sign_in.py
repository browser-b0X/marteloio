"""Since 0.3.0: no eBay account sign-in and no seller statistics.

A sign-in saved by 0.2.0 or earlier is deleted on start. (0.4.0 removed the remaining eBay
access too: see test_no_ebay_keys.py.) Temporary files only.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from fixtures_v020 import DataFolder, RunningApp, fake_dpapi

ROOT = Path(__file__).resolve().parents[1]
REMOVED_ROUTES = [("GET", "/ebay/userstats"), ("GET", "/ebay/authorize-url?redirect_uri=fixture"),
                  ("POST", "/ebay/token-user"), ("POST", "/ebay/token-refresh")]


def quiet(function):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        function()
    return out.getvalue()


class NoAccountSignInTests(unittest.TestCase):
    def setUp(self):
        self.data = DataFolder(self)

    def test_the_account_and_seller_statistics_routes_are_gone(self):
        app = RunningApp(self)
        for method, path in REMOVED_ROUTES:
            with self.subTest(path=path):
                status, data = app.request(method, path, body={} if method == "POST" else None)
                self.assertEqual((status, data.get("kind")), (404, "not_found"))

    def test_the_code_names_no_account_or_seller_endpoint(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        for gone in ("ws/api.dll", "GetUser", "auth.ebay.com", "authorization_code", "grant_type\": \"refresh_token",
                     "feedbackScore", "feedbackPercentage", "seller_feedback", "seller_pct", "EBAY_REDIRECT_URI"):
            self.assertNotIn(gone, source, gone)
        for name in ("trading_get_user", "user_token_fresh", "read_token", "write_token", "update_token"):
            self.assertFalse(hasattr(server, name), name)
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        for gone in ("/ebay/userstats", "/ebay/token-user", "/ebay/authorize-url", 'id="ruName"', 'id="connectBtn"',
                     'id="fetchStatsBtn"', "feedback_star"):
            self.assertNotIn(gone, page, gone)

    def test_a_sign_in_saved_by_an_older_version_is_removed_from_the_store(self):
        token = {"access_token": "old-access-fixture", "refresh_token": "old-refresh-fixture", "expires_at": 1}
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"ebay_client_id": "Seller-App-PRD-fixture", "ebay_client_secret": "PRD-fixture",
                                                "provider_keys": {"GROQ_API_KEY": "gsk_keep"}, "token": token}))
            Path(server.TOKEN_PATH).write_text(json.dumps(token))
            logged = quiet(server.forget_saved_sign_in)
            store = server.load_secrets()
            again = quiet(server.forget_saved_sign_in)
        self.assertIn("removed the eBay account sign-in", logged)
        self.assertNotIn("old-refresh-fixture", logged)
        self.assertEqual(store, {"ebay_client_id": "Seller-App-PRD-fixture", "ebay_client_secret": "PRD-fixture",
                                 "provider_keys": {"GROQ_API_KEY": "gsk_keep"}})
        self.assertFalse(os.path.exists(server.TOKEN_PATH))
        self.assertEqual(again, "")

    def test_without_encrypted_storage_the_plaintext_sign_in_file_is_removed(self):
        Path(server.TOKEN_PATH).write_text('{"access_token": "old", "refresh_token": "old-refresh"}')
        Path(server.ENV_PATH).write_text("EBAY_CLIENT_ID=Seller-App-PRD-fixture\n")
        with patch.object(server, "dpapi_available", return_value=False):
            logged = quiet(server.forget_saved_sign_in)
        self.assertIn("removed the eBay account sign-in", logged)
        self.assertEqual(self.data.names(), [".env"])
        self.assertEqual(Path(server.ENV_PATH).read_text(), "EBAY_CLIENT_ID=Seller-App-PRD-fixture\n")

    def test_a_sign_in_file_cut_off_mid_write_is_removed_too(self):
        for raw in ('{"access_token":"a","refresh_token":"REAL"', '{"refresh_token": "REAL", "expires'):
            with self.subTest(raw=raw):
                Path(server.TOKEN_PATH).write_text(raw)
                with patch.object(server, "dpapi_available", return_value=False):
                    logged = quiet(server.forget_saved_sign_in)
                self.assertFalse(os.path.exists(server.TOKEN_PATH))
                self.assertNotIn("REAL", logged)

    def test_a_failed_store_write_is_reported_as_a_retry_and_changes_nothing(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"ebay_client_id": "Seller-App-PRD-fixture", "token": {"refresh_token": "old"}}))
            before = Path(server.SECRETS_PATH).read_bytes()
            with patch.object(server, "atomic_write", side_effect=OSError("disk full")):
                logged = quiet(server.forget_saved_sign_in)
            self.assertIn("will retry next start", logged)
            self.assertNotIn("unreadable", logged)
            self.assertEqual(Path(server.SECRETS_PATH).read_bytes(), before)

    def test_a_sign_in_copied_in_while_running_goes_with_the_next_save(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"ebay_client_id": "Old-App-PRD", "token": {"refresh_token": "old"}}))
            with contextlib.redirect_stderr(io.StringIO()):
                server.save_provider_settings({"GROQ_API_KEY": "gsk_new_fixture"})
            self.assertEqual(server.load_secrets(), {"provider_keys": {"GROQ_API_KEY": "gsk_new_fixture"}})

    def test_a_sign_in_in_the_pre_rename_store_is_removed_and_keys_move(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"ebay_client_id": "Seller-App-PRD-fixture", "token": {"refresh_token": "old"}}))
            os.replace(server.SECRETS_PATH, server.LEGACY_SECRETS_PATH)
            quiet(server.forget_saved_sign_in)
            self.assertEqual(server.load_secrets(), {"ebay_client_id": "Seller-App-PRD-fixture"})
        self.assertNotIn(b"old", Path(server.secrets_read_path()).read_bytes())

    def test_startup_forgets_the_sign_in_before_anything_else_reads_the_store(self):
        order = []

        class Stop(Exception):
            pass

        class FakeServer:
            def serve_forever(self):
                raise Stop()

            def server_close(self):
                order.append("closed")

        with patch.object(server, "load_env"), patch.object(server, "bind_server", return_value=FakeServer()), \
                patch.object(server, "forget_saved_sign_in", side_effect=lambda: order.append("forget")), \
                patch.object(server, "forget_ebay_keys", side_effect=lambda: order.append("keys")), \
                patch.object(server, "report_unreadable_store", side_effect=lambda: order.append("report")), \
                patch.object(server, "PORT", 8080), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(Stop):
                server.main()
        self.assertEqual(order, ["forget", "keys", "report", "closed"])

    def test_a_file_that_is_not_a_sign_in_is_left_alone(self):
        for raw in ("[]", '"text"', '{"access_token": 5}', "{}", "{not json"):
            with self.subTest(raw=raw):
                Path(server.TOKEN_PATH).write_text(raw)
                with fake_dpapi():
                    logged = quiet(server.forget_saved_sign_in)
                self.assertEqual(Path(server.TOKEN_PATH).read_text(), raw)
                self.assertIn("left in place", logged)

    def test_an_unreadable_store_is_never_rewritten(self):
        Path(server.SECRETS_PATH).write_text("!!!not-valid-base64-or-ciphertext!!!")
        with fake_dpapi():
            logged = quiet(server.forget_saved_sign_in)
        self.assertEqual(Path(server.SECRETS_PATH).read_text(), "!!!not-valid-base64-or-ciphertext!!!")
        self.assertEqual(self.data.names(), [".marteloio-secrets.enc"])
        self.assertIn("left as it is", logged)

    def test_a_store_without_a_sign_in_is_not_rewritten(self):
        with fake_dpapi():
            self.assertTrue(server.save_secrets({"ebay_client_id": "Seller-App-PRD-fixture"}))
            before = Path(server.SECRETS_PATH).read_bytes()
            with patch.object(server, "_store_write", side_effect=AssertionError("no write needed")):
                self.assertEqual(quiet(server.forget_saved_sign_in), "")
            self.assertEqual(Path(server.SECRETS_PATH).read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
