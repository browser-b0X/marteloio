"""Offline regression checks for the .env, DPAPI secrets-store and migration paths.

Every check runs against throwaway paths inside a fresh temp dir: the module
redirects ``server.ENV_PATH``, ``server.SECRETS_PATH`` and ``server.TOKEN_PATH``
before calling the real functions. No ports are opened and no provider is contacted
(``server.py`` keeps its startup behind its ``__main__`` guard).

The project's real ``.env``, ``.marteloio-secrets.enc`` (and the pre-rename
``.lanzalister-secrets.enc``) and ``.ebay_token.json`` are
hashed at import and re-hashed after every test, so a redirect that silently stops
working fails the suite instead of corrupting live credentials. ``migrate_secrets()``
deletes the token file it was pointed at, which is why that third path is guarded too.
If another process writes those files mid-run the guard trips as well, which is the
point: this suite must never be the reason a credential changed.
"""
import contextlib
import hashlib
import io
import json
import os
from base64 import b64decode, b64encode
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

REAL_ENV_PATH = server.ENV_PATH
REAL_SECRETS_PATH = server.SECRETS_PATH
REAL_LEGACY_SECRETS_PATH = server.LEGACY_SECRETS_PATH
REAL_TOKEN_PATH = server.TOKEN_PATH
REAL_SETTINGS_PATH = server.SETTINGS_PATH


def snapshot(path):
    if not os.path.exists(path):
        return None
    stat_result = os.stat(path)
    with open(path, "rb") as handle:
        return (stat_result.st_mtime_ns, stat_result.st_size, hashlib.sha256(handle.read()).hexdigest())


REAL_ENV_BEFORE = snapshot(REAL_ENV_PATH)
REAL_SECRETS_BEFORE = snapshot(REAL_SECRETS_PATH)
REAL_LEGACY_SECRETS_BEFORE = snapshot(REAL_LEGACY_SECRETS_PATH)
REAL_TOKEN_BEFORE = snapshot(REAL_TOKEN_PATH)
REAL_SETTINGS_BEFORE = snapshot(REAL_SETTINGS_PATH)


class IsolatedCredentialPaths(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="marteloio-test-")
        for name, value in (("ENV_PATH", os.path.join(self.base, "env-under-test")),
                            ("SECRETS_PATH", os.path.join(self.base, "store-under-test")),
                            ("LEGACY_SECRETS_PATH", os.path.join(self.base, "legacy-store-under-test")),
                            ("TOKEN_PATH", os.path.join(self.base, "token-under-test")),
                            ("SETTINGS_PATH", os.path.join(self.base, "settings-under-test"))):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
            setattr(self, name.lower(), value)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        self.assertFalse(os.path.exists(self.base), "temp dir left behind")
        self.assertEqual(snapshot(REAL_ENV_PATH), REAL_ENV_BEFORE, "the project's real .env changed")
        self.assertEqual(snapshot(REAL_SECRETS_PATH), REAL_SECRETS_BEFORE, "the real secrets store changed")
        self.assertEqual(snapshot(REAL_LEGACY_SECRETS_PATH), REAL_LEGACY_SECRETS_BEFORE, "the real legacy store changed")
        self.assertEqual(snapshot(REAL_TOKEN_PATH), REAL_TOKEN_BEFORE, "the real .ebay_token.json changed")
        self.assertEqual(snapshot(REAL_SETTINGS_PATH), REAL_SETTINGS_BEFORE, "the real settings.json changed")

    def read(self):
        with open(server.ENV_PATH, encoding="utf-8") as handle:
            return handle.read()

    def seed(self, text):
        # newline="" writes the text byte-for-byte, so CRLF fixtures stay CRLF on Windows too.
        with open(server.ENV_PATH, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

    def assertNoTempLeftovers(self):
        self.assertEqual([n for n in os.listdir(self.base) if n.startswith((".marteloio-", ".lanzalister-"))], [])


class EnvWritePathTests(IsolatedCredentialPaths):
    def test_write_env_creates_a_single_line_file(self):
        server.write_env({"GROQ_API_KEY": "gsk_fixture_value"})
        self.assertTrue(os.path.exists(server.ENV_PATH))
        self.assertEqual(self.read(), "GROQ_API_KEY=gsk_fixture_value\n")
        self.assertEqual(server.read_env(), {"GROQ_API_KEY": "gsk_fixture_value"})
        self.assertNoTempLeftovers()

    def test_update_in_place_preserves_comments_blanks_and_order(self):
        # A legacy MISTRAL_API_KEY line is ignored by the app but left untouched.
        self.seed("# leading comment\nGROQ_API_KEY=old\n\nGEMINI_API_KEY=keepme\n# trailing comment\nMISTRAL_API_KEY=alsokeep\n")
        server.write_env({"GROQ_API_KEY": "new"})
        lines = self.read().splitlines()
        self.assertIn("# leading comment", self.read())
        self.assertIn("# trailing comment", self.read())
        self.assertIn("\n\n", self.read())
        self.assertIn("GEMINI_API_KEY=keepme", self.read())
        self.assertIn("MISTRAL_API_KEY=alsokeep", self.read())
        self.assertNotIn("old", self.read())
        self.assertEqual(lines.index("GROQ_API_KEY=new"), 1)
        self.assertEqual(self.read().count("GROQ_API_KEY="), 1)

    def test_pre_existing_duplicate_key_collapses_to_one(self):
        self.seed("GROQ_API_KEY=first\nGEMINI_API_KEY=g\nGROQ_API_KEY=second\n")
        server.write_env({"GROQ_API_KEY": "third"})
        self.assertEqual(self.read().count("GROQ_API_KEY="), 1)
        self.assertEqual(self.read().splitlines()[0], "GROQ_API_KEY=third")
        self.assertIn("GEMINI_API_KEY=g", self.read())

    def test_absent_key_is_appended(self):
        self.seed("GROQ_API_KEY=a\n")
        server.write_env({"OPENROUTER_API_KEY": "m"})
        self.assertEqual(self.read().splitlines(), ["GROQ_API_KEY=a", "OPENROUTER_API_KEY=m"])

    def test_keys_outside_the_allow_list_are_rejected_wholesale(self):
        self.seed("GROQ_API_KEY=a\nOPENROUTER_API_KEY=m\n")
        before = self.read()
        for bad in ({"PATH": "/evil"}, {"MISTRAL_API_KEY": "legacy"}):
            with self.assertRaises(ValueError):
                server.write_env(bad)
            self.assertEqual(self.read(), before)
        with self.assertRaises(ValueError) as error:
            server.write_env({"PATH": "/evil"})
        self.assertEqual(str(error.exception), "Unsupported setting")
        self.assertEqual(self.read(), before)
        with self.assertRaises(ValueError) as error:
            server.write_env({"GROQ_API_KEY": "ok", "EBAY_CLIENT_ID": "cid", "SHELL": "x"})
        self.assertEqual(str(error.exception), "Unsupported setting")
        self.assertEqual(self.read(), before)
        self.assertNotIn("SHELL", self.read())
        self.assertEqual(set(server.SETTING_KEYS) | {"EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"},
                         {"GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "FREELLMAPI_KEY",
                          "FREELLMAPI_URL", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"})

    def test_safe_value_blocks_env_line_injection(self):
        for value in ("a\nb", "a\rb", "a\x7fb", "a\x00b", "x" * 8193, 123, None):
            with self.assertRaises(ValueError, msg=repr(value)):
                server.safe_value(value)
        self.assertEqual(server.safe_value("x" * 8192), "x" * 8192)
        self.assertEqual(server.safe_value("  key  "), "key")
        self.seed("GROQ_API_KEY=a\n")
        with self.assertRaises(ValueError) as error:
            server.write_env({"GROQ_API_KEY": "bad\nGEMINI_API_KEY=injected"})
        self.assertIn("Control characters", str(error.exception))
        self.assertNotIn("injected", self.read())
        self.assertEqual(self.read(), "GROQ_API_KEY=a\n")

    def test_safe_value_rejects_unicode_line_separators(self):
        for ch in ("\u2028", "\u2029", "\x85", "\x9f", "\x1c", "\x1e"):
            with self.assertRaises(ValueError, msg=repr(ch)):
                server.safe_value("key" + ch + "GEMINI_API_KEY=injected")
        self.seed("GROQ_API_KEY=a\n")
        with self.assertRaises(ValueError):
            server.write_env({"GROQ_API_KEY": "bad\u2028GEMINI_API_KEY=injected"})
        self.assertEqual(self.read(), "GROQ_API_KEY=a\n")
        self.assertEqual(server.safe_value("caf\u00e9 \u00a0key"), "caf\u00e9 \u00a0key")

    def test_env_rewrites_split_on_newlines_only(self):
        # A legacy value containing U+2028 must stay on its own line, not become a key.
        self.seed("GEMINI_API_KEY=old\u2028GROQ_API_KEY=smuggled\r\nOPENROUTER_API_KEY=m\n")
        server.write_env({"GROQ_API_KEY": "real"})
        self.assertEqual(self.read(), "GEMINI_API_KEY=old\u2028GROQ_API_KEY=smuggled\n"
                                      "OPENROUTER_API_KEY=m\nGROQ_API_KEY=real\n")
        server.rewrite_env_without({"OPENROUTER_API_KEY"})
        self.assertEqual(self.read(), "GEMINI_API_KEY=old\u2028GROQ_API_KEY=smuggled\nGROQ_API_KEY=real\n")

    def test_utf8_bom_does_not_hide_the_first_key(self):
        with open(server.ENV_PATH, "w", encoding="utf-8-sig") as handle:
            handle.write("GROQ_API_KEY=bom-fixture\nGEMINI_API_KEY=g\n")
        self.assertEqual(server.read_env(), {"GROQ_API_KEY": "bom-fixture", "GEMINI_API_KEY": "g"})
        with patch.dict(os.environ, {}, clear=True):
            server.load_env()
            self.assertEqual(os.environ.get("GROQ_API_KEY"), "bom-fixture")
        server.write_env({"GROQ_API_KEY": "replaced"})
        self.assertEqual(self.read(), "GROQ_API_KEY=replaced\nGEMINI_API_KEY=g\n")
        with open(server.ENV_PATH, "w", encoding="utf-8-sig") as handle:
            handle.write("GROQ_API_KEY=bom-fixture\nGEMINI_API_KEY=g\n")
        server.rewrite_env_without({"GROQ_API_KEY"})
        with open(server.ENV_PATH, "rb") as handle:
            # No BOM is written back; line endings follow the platform's text mode.
            self.assertEqual(handle.read(), ("GEMINI_API_KEY=g" + os.linesep).encode())

    def test_rewrite_env_without_drops_only_the_named_keys(self):
        self.seed("# c\nGROQ_API_KEY=a\n\nGEMINI_API_KEY=b\nOPENROUTER_API_KEY=c\n")
        server.rewrite_env_without(["GROQ_API_KEY", "OPENROUTER_API_KEY"])
        self.assertNotIn("GROQ_API_KEY", self.read())
        self.assertNotIn("OPENROUTER_API_KEY", self.read())
        self.assertIn("GEMINI_API_KEY=b", self.read())
        self.assertIn("# c", self.read())
        self.assertNoTempLeftovers()

    def test_rewrite_env_without_a_missing_file_is_a_silent_no_op(self):
        patcher = patch.object(server, "ENV_PATH", os.path.join(self.base, "does-not-exist"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.assertIsNone(server.rewrite_env_without(["GROQ_API_KEY"]))
        self.assertFalse(os.path.exists(server.ENV_PATH))

    def test_a_failing_chmod_does_not_break_the_write(self):
        # atomic_write treats os.chmod as best-effort. Its result is deliberately not
        # asserted anywhere: on Windows chmod(0o600) is a no-op and the mode stays 666,
        # so a mode assertion would encode a platform difference rather than a contract.
        with patch("os.chmod", side_effect=OSError("chmod unsupported on this platform")):
            server.write_env({"GROQ_API_KEY": "after-chmod-failure"})
            self.assertIn("GROQ_API_KEY=after-chmod-failure", self.read())
            server.rewrite_env_without(["GROQ_API_KEY"])
            self.assertNotIn("GROQ_API_KEY", self.read())
        self.assertNoTempLeftovers()

    def test_transient_windows_replace_failure_retries_atomically(self):
        self.seed('GROQ_API_KEY=old-fixture\n')
        replace = os.replace
        attempts = []
        def replacing(source, target):
            attempts.append(1)
            if len(attempts) == 1:
                self.assertIn('old-fixture', self.read())
                raise PermissionError('fixture contention')
            return replace(source, target)
        with patch.object(server.os, 'name', 'nt'), patch.object(server.os, 'replace', side_effect=replacing), patch.object(server.time, 'sleep') as sleep:
            server.write_env({'GROQ_API_KEY': 'new-fixture'})
            sleep.assert_called_once_with(0.05)
        self.assertEqual(len(attempts), 2)
        self.assertIn('new-fixture', self.read())
        self.assertNoTempLeftovers()

    def test_persistent_windows_replace_failure_is_bounded_and_keeps_original(self):
        self.seed('GROQ_API_KEY=old-fixture\n')
        with patch.object(server.os, 'name', 'nt'), patch.object(server.os, 'replace', side_effect=PermissionError('fixture denial')) as replace, patch.object(server.time, 'sleep') as sleep:
            with self.assertRaises(PermissionError):
                server.write_env({'GROQ_API_KEY': 'new-fixture'})
            self.assertEqual(replace.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
        self.assertIn('old-fixture', self.read())
        self.assertNoTempLeftovers()

    def test_without_dpapi_the_store_refuses_rather_than_writing_plaintext(self):
        with patch.object(server, "dpapi_available", return_value=False):
            self.assertFalse(server.save_secrets({"a": "b"}))
            self.assertEqual(server.load_secrets(), {})
            self.assertFalse(server.set_ebay_creds(cid="x", csec="y"))
        self.assertFalse(os.path.exists(server.SECRETS_PATH))


@unittest.skipUnless(server.dpapi_available(), "DPAPI is only available on Windows")
class SecretStoreTests(IsolatedCredentialPaths):
    SECRET = "SEC-fixture-9f3a-do-not-leak"

    def test_round_trip_stores_ciphertext_not_plaintext(self):
        self.assertTrue(server.save_secrets({"ebay_client_id": "CID-fixture",
                                             "ebay_client_secret": self.SECRET}))
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "CID-fixture",
                                                 "ebay_client_secret": self.SECRET})
        with open(server.SECRETS_PATH, "rb") as handle:
            raw = handle.read()
        self.assertNotIn(self.SECRET.encode(), raw)
        self.assertNotIn(b"CID-fixture", raw)
        decoded = b64decode(raw.strip(), validate=True)
        self.assertTrue(decoded)
        self.assertNotEqual(decoded, raw.strip())
        self.assertEqual(b64encode(decoded), raw.strip())
        self.assertNoTempLeftovers()

    def test_set_ebay_creds_merges_and_wins_over_the_environment(self):
        self.assertTrue(server.save_secrets({"ebay_client_id": "CID-fixture",
                                             "ebay_client_secret": self.SECRET}))
        server.set_ebay_creds(cid="CID-2")
        loaded = server.load_secrets()
        self.assertEqual(loaded.get("ebay_client_id"), "CID-2")
        self.assertEqual(loaded.get("ebay_client_secret"), self.SECRET)
        with patch.dict(os.environ, {"EBAY_CLIENT_ID": "CID-from-env"}):
            self.assertEqual(server.get_ebay_cred("ebay_client_id"), "CID-2")
        self.assertNoTempLeftovers()

    def test_a_corrupt_store_reports_the_specific_error_then_recovers(self):
        with open(server.SECRETS_PATH, "w", encoding="utf-8") as handle:
            handle.write("!!!not-valid-base64-or-ciphertext!!!")
        with self.assertRaises(OSError) as error:
            server.load_secrets()
        self.assertEqual(str(error.exception),
                         "Cannot read encrypted credentials; restore the store or use its original Windows account")
        # Saving keys again starts a new store; the unreadable one is kept under a new name.
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(server.set_ebay_creds(cid="x"))
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "x"})
        kept = [name for name in os.listdir(self.base) if ".unreadable-" in name]
        self.assertEqual(len(kept), 1)
        with open(os.path.join(self.base, kept[0]), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "!!!not-valid-base64-or-ciphertext!!!")
        self.assertTrue(server.save_secrets({"ebay_client_id": "CID-3"}))
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "CID-3"})
        self.assertNoTempLeftovers()


@unittest.skipUnless(server.dpapi_available(), "DPAPI is only available on Windows")
class MigrateSecretsTests(IsolatedCredentialPaths):
    CID = "CID-migrate-fixture"
    CSEC = "SEC-migrate-fixture-do-not-leak"
    TOKEN = {"access_token": "v^1.1#i$1.1-fixture", "expires_in": 7200}

    def migrate(self):
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            server.migrate_secrets()
        return captured.getvalue()

    def seed_env(self):
        self.seed("# provider keys stay put\nGROQ_API_KEY=gsk_keep\n"
                  "EBAY_CLIENT_ID=%s\nEBAY_CLIENT_SECRET=%s\n" % (self.CID, self.CSEC))

    def seed_token(self):
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as handle:
            json.dump(self.TOKEN, handle)

    def test_a_confirmed_store_write_is_what_licenses_destroying_the_plaintext(self):
        self.seed_env()
        self.seed_token()
        with patch.dict(os.environ, {"EBAY_CLIENT_ID": self.CID, "EBAY_CLIENT_SECRET": self.CSEC}):
            logged = self.migrate()
            self.assertFalse("EBAY_CLIENT_ID" in os.environ, "Migrated client ID remained in the environment")
            self.assertFalse("EBAY_CLIENT_SECRET" in os.environ, "Migrated client secret remained in the environment")
        self.assertIn("migrated eBay credentials/token", logged)
        stored = server.load_secrets()
        self.assertEqual(stored["ebay_client_id"], self.CID)
        self.assertEqual(stored["ebay_client_secret"], self.CSEC)
        self.assertEqual(stored["token"], self.TOKEN)
        self.assertEqual(server.read_token(), self.TOKEN)
        env_text = self.read()
        self.assertNotIn("EBAY_CLIENT_ID", env_text)
        self.assertNotIn("EBAY_CLIENT_SECRET", env_text)
        self.assertNotIn(self.CSEC, env_text)
        self.assertIn("# provider keys stay put", env_text)
        self.assertIn("GROQ_API_KEY=gsk_keep", env_text)
        self.assertFalse(os.path.exists(server.TOKEN_PATH))
        with open(server.SECRETS_PATH, "rb") as handle:
            self.assertNotIn(self.CSEC.encode(), handle.read())
        self.assertNoTempLeftovers()

    def test_a_second_run_finds_nothing_and_changes_nothing(self):
        self.seed_env()
        with patch.dict(os.environ):
            self.migrate()
            first_store = server.load_secrets()
            first_env = self.read()
            self.assertTrue(first_store["ebay_client_id"])
            logged = self.migrate()
        self.assertEqual(server.load_secrets(), first_store)
        self.assertEqual(self.read(), first_env)
        self.assertEqual(logged, "")
        self.assertNoTempLeftovers()

    def test_a_failed_store_write_leaves_every_plaintext_copy_in_place(self):
        self.seed_env()
        self.seed_token()
        env_before = self.read()
        with patch.object(server, "save_secrets", return_value=False):
            logged = self.migrate()
        self.assertIn("leaving plaintext in place", logged)
        self.assertEqual(self.read(), env_before)
        self.assertIn(self.CSEC, self.read())
        self.assertTrue(os.path.exists(server.TOKEN_PATH), "the token was deleted before it was encrypted")
        with open(server.TOKEN_PATH, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), self.TOKEN)
        self.assertFalse(os.path.exists(server.SECRETS_PATH))
        self.assertNoTempLeftovers()

    def test_a_store_it_cannot_read_is_never_overwritten(self):
        self.seed_env()
        self.seed_token()
        with open(server.SECRETS_PATH, "w", encoding="utf-8") as handle:
            handle.write("!!!not-valid-base64-or-ciphertext!!!")
        corrupt_before = snapshot(server.SECRETS_PATH)
        env_before = self.read()
        logged = self.migrate()
        self.assertIn("migration stopped without changing credentials", logged)
        self.assertEqual(snapshot(server.SECRETS_PATH), corrupt_before)
        self.assertEqual(self.read(), env_before)
        self.assertEqual(server.read_env()["EBAY_CLIENT_SECRET"], self.CSEC)
        self.assertTrue(os.path.exists(server.TOKEN_PATH))
        self.assertNoTempLeftovers()

    def test_an_unparseable_token_file_survives_while_credentials_still_move(self):
        self.seed_env()
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        with patch.dict(os.environ):
            logged = self.migrate()
        self.assertIn("migrated eBay credentials/token", logged)
        self.assertEqual(server.load_secrets()["ebay_client_id"], self.CID)
        self.assertNotIn("EBAY_CLIENT_ID", self.read())
        self.assertTrue(os.path.exists(server.TOKEN_PATH), "a token file it could not parse was deleted")
        with open(server.TOKEN_PATH, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "{not json")
        self.assertNoTempLeftovers()

    def test_with_nothing_to_migrate_no_store_is_created(self):
        self.seed("# provider keys only\nGROQ_API_KEY=gsk_keep\n")
        env_before = self.read()
        self.assertEqual(self.migrate(), "")
        self.assertFalse(os.path.exists(server.SECRETS_PATH))
        self.assertEqual(self.read(), env_before)


class LegacyStoreRenameTests(IsolatedCredentialPaths):
    """The pre-rename store is read until a verified write of the new file.

    A reversible fake replaces DPAPI so this runs on every platform."""

    def setUp(self):
        super().setUp()
        for name, value in (("dpapi_available", lambda: True),
                            ("dpapi_encrypt", lambda data: b"fake-dpapi:" + data[::-1]),
                            ("dpapi_decrypt", self.fake_decrypt)):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def fake_decrypt(blob):
        if not blob.startswith(b"fake-dpapi:"):
            raise OSError("fixture: not a fake blob")
        return blob[len(b"fake-dpapi:"):][::-1]

    def write_store(self, path, data):
        with open(path, "w", encoding="ascii") as handle:
            handle.write(b64encode(server.dpapi_encrypt(json.dumps(data).encode())).decode("ascii"))

    def test_read_path_prefers_new_store_then_legacy(self):
        self.assertEqual(server.secrets_read_path(), server.SECRETS_PATH)
        self.write_store(server.LEGACY_SECRETS_PATH, {"ebay_client_id": "legacy-fixture"})
        self.assertEqual(server.secrets_read_path(), server.LEGACY_SECRETS_PATH)
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "legacy-fixture"})
        self.write_store(server.SECRETS_PATH, {"ebay_client_id": "new-fixture"})
        self.assertEqual(server.secrets_read_path(), server.SECRETS_PATH)
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "new-fixture"})

    def test_first_write_moves_legacy_contents_and_then_removes_it(self):
        self.write_store(server.LEGACY_SECRETS_PATH, {"ebay_client_id": "legacy-fixture",
                                                      "provider_keys": {"GROQ_API_KEY": "legacy-key-fixture"}})
        self.assertTrue(server.set_ebay_creds(csec="secret-fixture"))
        self.assertFalse(os.path.exists(server.LEGACY_SECRETS_PATH))
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "legacy-fixture", "ebay_client_secret": "secret-fixture",
                                                 "provider_keys": {"GROQ_API_KEY": "legacy-key-fixture"}})
        self.assertNoTempLeftovers()

    def test_failed_new_write_keeps_the_legacy_store(self):
        self.write_store(server.LEGACY_SECRETS_PATH, {"ebay_client_id": "legacy-fixture"})
        with open(server.LEGACY_SECRETS_PATH, "rb") as handle:
            before = handle.read()
        with patch.object(server, "atomic_write", side_effect=OSError("fixture disk full")):
            self.assertFalse(server.set_ebay_creds(cid="replacement-fixture"))
        with patch.object(server, "dpapi_decrypt", side_effect=[b'{"ebay_client_id": "legacy-fixture"}', b"{}"]):
            self.assertFalse(server.set_ebay_creds(cid="replacement-fixture"))  # round-trip mismatch
        with open(server.LEGACY_SECRETS_PATH, "rb") as handle:
            self.assertEqual(handle.read(), before)
        self.assertFalse(os.path.exists(server.SECRETS_PATH))

    def test_unverified_new_file_keeps_the_legacy_store(self):
        self.write_store(server.LEGACY_SECRETS_PATH, {"ebay_client_id": "legacy-fixture"})
        original = server._store_read_raw
        def unreadable_new(path=None):
            if path == server.SECRETS_PATH:
                raise OSError("fixture: new file unreadable")
            return original(path)
        with patch.object(server, "_store_read_raw", side_effect=unreadable_new):
            self.assertTrue(server.set_ebay_creds(cid="new-fixture"))
        self.assertTrue(os.path.exists(server.LEGACY_SECRETS_PATH))
        self.assertEqual(server.load_secrets(), {"ebay_client_id": "new-fixture"})


class MigrationFallbackTests(IsolatedCredentialPaths):
    """Runs on any platform: the no-DPAPI branch is reached by patching, not by OS."""

    def test_without_dpapi_migration_leaves_the_plaintext_alone(self):
        self.seed("EBAY_CLIENT_ID=CID-fallback\nEBAY_CLIENT_SECRET=SEC-fallback\n")
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as handle:
            json.dump({"access_token": "plain-fallback"}, handle)
        env_before = self.read()
        with patch.object(server, "dpapi_available", return_value=False):
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                server.migrate_secrets()
            self.assertIn("DPAPI unavailable", captured.getvalue())
            self.assertEqual(server.read_token(), {"access_token": "plain-fallback"})
        self.assertEqual(self.read(), env_before)
        self.assertFalse(os.path.exists(server.SECRETS_PATH))
        self.assertNoTempLeftovers()


if __name__ == "__main__":
    unittest.main()
