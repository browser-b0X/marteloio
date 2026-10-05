"""Provider persistence against temporary paths, with real-file hash guards."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from test_env_paths import IsolatedCredentialPaths


class ProviderEnvironmentTests(unittest.TestCase):
    def test_encrypted_values_override_legacy_and_empty_disables_inherited(self):
        result = server.provider_environment({'GROQ_API_KEY': 'legacy', 'GEMINI_API_KEY': 'inherited'},
                                            {'provider_keys': {'GROQ_API_KEY': 'encrypted', 'GEMINI_API_KEY': ''}})
        self.assertTrue(result['GROQ_API_KEY'] == 'encrypted')
        self.assertFalse(result['GEMINI_API_KEY'])

    def test_invalid_store_fails_closed(self):
        for store in [[], {'provider_keys': []}, {'provider_keys': {'GROQ_API_KEY': ['bad']}}]:
            with self.assertRaises(OSError):
                server.provider_environment({}, store)


@unittest.skipUnless(server.dpapi_available(), 'DPAPI is only available on Windows')
class EncryptedProviderTests(IsolatedCredentialPaths):
    def test_replacing_connection_removes_old_refresh_but_preserves_other_secrets(self):
        self.assertTrue(server.save_secrets({'provider_keys': {'GROQ_API_KEY': 'provider-fixture'}, 'ebay_client_id': 'client-fixture',
                                            'token': {'access_token': 'old-fixture', 'refresh_token': 'old-refresh-fixture'}}))
        server.write_token({'access_token': 'new-fixture'})
        store = server.load_secrets()
        self.assertEqual(store['token'], {'access_token': 'new-fixture'})
        self.assertEqual(store['provider_keys'], {'GROQ_API_KEY': 'provider-fixture'})
        self.assertEqual(store['ebay_client_id'], 'client-fixture')

    def test_malformed_encrypted_store_is_preserved_and_blocks_ebay_writes(self):
        import json
        from base64 import b64encode
        for value in ([], {'ebay_client_id': []}, {'token': 'invalid-fixture'}):
            blob = b64encode(server.dpapi_encrypt(json.dumps(value).encode())).decode('ascii')
            Path(self.secrets_path).write_text(blob)
            with self.assertRaises(OSError):
                server.load_secrets()
            self.assertFalse(server.set_ebay_creds('replacement-fixture'))
            self.assertEqual(Path(self.secrets_path).read_text(), blob)

    def test_save_preserves_other_secrets_and_strips_only_saved_plaintext(self):
        self.assertTrue(server.save_secrets({'ebay_client_id': 'ebay-fixture', 'token': {'refresh_token': 'token-fixture'}}))
        Path(self.env_path).write_text('GROQ_API_KEY=old-fixture\nGEMINI_API_KEY=keep-fixture\nPORT=8080\n')
        result = server.save_provider_settings({'GROQ_API_KEY': 'new-private-fixture'})
        self.assertEqual(result, {'encrypted': True, 'cleanup_pending': False})
        store = server.load_secrets()
        self.assertTrue(store['provider_keys']['GROQ_API_KEY'] == 'new-private-fixture')
        self.assertTrue(store['ebay_client_id'] == 'ebay-fixture')
        self.assertTrue(store['token']['refresh_token'] == 'token-fixture')
        self.assertNotIn('GROQ_API_KEY', server.read_env())
        self.assertTrue(server.read_env()['GEMINI_API_KEY'] == 'keep-fixture')
        self.assertNotIn('new-private-fixture', Path(self.secrets_path).read_text())

    def test_failed_encryption_preserves_plaintext(self):
        Path(self.env_path).write_text('GROQ_API_KEY=keep-fixture\n')
        with patch.object(server, '_store_write', return_value=False):
            with self.assertRaises(OSError):
                server.save_provider_settings({'GROQ_API_KEY': 'replacement-fixture'})
        self.assertTrue(server.read_env()['GROQ_API_KEY'] == 'keep-fixture')

    def test_unreadable_store_is_not_overwritten(self):
        Path(self.secrets_path).write_text('unreadable-fixture')
        with self.assertRaises(OSError):
            server.save_provider_settings({'GROQ_API_KEY': 'replacement-fixture'})
        self.assertEqual(Path(self.secrets_path).read_text(), 'unreadable-fixture')

    def test_plaintext_cleanup_failure_is_reported_after_verified_save(self):
        Path(self.env_path).write_text('GROQ_API_KEY=old-fixture\n')
        with patch.object(server, 'rewrite_env_without', side_effect=OSError('fixture')):
            result = server.save_provider_settings({'GROQ_API_KEY': 'encrypted-fixture'})
        self.assertTrue(result['cleanup_pending'])
        self.assertTrue(server.provider_environment(server.read_env())['GROQ_API_KEY'] == 'encrypted-fixture')
        self.assertTrue(server.read_env()['GROQ_API_KEY'] == 'old-fixture')

    def test_removal_stores_empty_override_and_cannot_restore_old_environment_key(self):
        server.save_provider_settings({'GROQ_API_KEY': ''})
        self.assertFalse(server.provider_environment({'GROQ_API_KEY': 'inherited-fixture'})['GROQ_API_KEY'])


class PlaintextProviderTests(IsolatedCredentialPaths):
    def test_non_windows_fallback_preserves_other_settings(self):
        Path(self.env_path).write_text('GEMINI_API_KEY=keep-fixture\nPORT=8181\n')
        with patch.object(server, 'dpapi_available', return_value=False):
            result = server.save_provider_settings({'GROQ_API_KEY': 'plain-fixture'})
        self.assertFalse(result['encrypted'])
        self.assertTrue(server.read_env()['GROQ_API_KEY'] == 'plain-fixture')
        self.assertTrue(server.read_env()['GEMINI_API_KEY'] == 'keep-fixture')


if __name__ == '__main__':
    unittest.main()
