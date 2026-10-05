"""OAuth lifecycle regressions; temporary files and fake HTTP responses only."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from test_env_paths import IsolatedCredentialPaths


class ObservedLock:
    def __init__(self):
        self.lock = threading.RLock()
        self.entered = 0
        self.waiter = threading.Event()

    def __enter__(self):
        self.entered += 1
        if self.entered == 2:
            self.waiter.set()
        self.lock.acquire()

    def __exit__(self, *args):
        self.lock.release()


def handler():
    instance = server.Handler.__new__(server.Handler)
    instance.send_json = Mock()
    return instance


class OAuthTokensTests(IsolatedCredentialPaths):
    def setUp(self):
        super().setUp()
        plaintext = patch.object(server, 'dpapi_available', return_value=False)
        plaintext.start()
        self.addCleanup(plaintext.stop)

    def test_new_authorization_replaces_old_account_refresh_token(self):
        server.write_token({'access_token': 'old', 'refresh_token': 'old-account-refresh'})
        request = handler()
        request.path = '/ebay/token-user'
        request.read_json = lambda: {'code': 'fixture-code', 'state': 'fixture-state', 'redirect_uri': 'fixture-redirect'}
        with patch.object(server, '_OAUTH_STATES', {'fixture-state': (time.monotonic() + 60, 'fixture-redirect')}), patch.object(server, 'exchange_grant', return_value=(200, {'access_token': 'new-account', 'expires_at': time.time() + 7200})):
            request.route_post()
        self.assertEqual(server.read_token()['access_token'], 'new-account')
        self.assertNotIn('refresh_token', server.read_token())
        request.send_json.assert_called_once_with({'connected': True})

    def test_refresh_preserves_existing_refresh_token_when_not_rotated(self):
        server.write_token({'access_token': 'old', 'refresh_token': 'same-account-refresh', 'expires_at': 0})
        with patch.object(server, 'exchange_grant', return_value=(200, {'access_token': 'renewed', 'expires_at': time.time() + 7200})):
            result = server.user_token_fresh()
        self.assertEqual(result['access_token'], 'renewed')
        self.assertEqual(result['refresh_token'], 'same-account-refresh')

    def test_invalid_oauth_state_never_exchanges_or_changes_tokens(self):
        server.write_token({'access_token': 'existing', 'refresh_token': 'keep'})
        for submitted, pending in [
            ('', {}), ('unknown', {}),
            ('expired', {'expired': (time.monotonic() - 1, 'redirect')}),
            ('mismatch', {'mismatch': (time.monotonic() + 60, 'other-redirect')}),
        ]:
            with self.subTest(state=submitted):
                request = handler()
                request.path = '/ebay/token-user'
                request.read_json = lambda: {'code': 'fixture', 'state': submitted, 'redirect_uri': 'redirect'}
                with patch.object(server, '_OAUTH_STATES', pending), patch.object(server, 'exchange_grant') as exchange:
                    request.route_post()
                exchange.assert_not_called()
                self.assertEqual(request.send_json.call_args.args[1], 400)
                self.assertEqual(server.read_token(), {'access_token': 'existing', 'refresh_token': 'keep'})

    def test_oauth_state_cannot_be_replayed_after_success(self):
        request = handler()
        request.path = '/ebay/token-user'
        request.read_json = lambda: {'code': 'fixture', 'state': 'once', 'redirect_uri': 'redirect'}
        with patch.object(server, '_OAUTH_STATES', {'once': (time.monotonic() + 60, 'redirect')}), patch.object(
            server, 'exchange_grant', return_value=(200, {'access_token': 'new', 'expires_at': time.time() + 7200})
        ) as exchange:
            request.route_post()
            request.send_json.assert_called_once_with({'connected': True})
            request.send_json.reset_mock()
            request.route_post()
            exchange.assert_called_once()
            self.assertEqual(request.send_json.call_args.args[1], 400)

    def test_concurrent_refreshes_share_one_successful_exchange(self):
        server.write_token({'access_token': 'old', 'refresh_token': 'refresh', 'expires_at': 0})
        entered, release = threading.Event(), threading.Event()
        lock = ObservedLock()
        def exchange(body):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Fixture timed out')
            return 200, {'access_token': 'renewed', 'expires_at': time.time() + 7200}
        with patch.object(server, '_USER_TOKEN_LOCK', lock), patch.object(server, 'exchange_grant', side_effect=exchange) as grant:
            with ThreadPoolExecutor(max_workers=2) as workers:
                first = workers.submit(server.user_token_fresh)
                try:
                    self.assertTrue(entered.wait(2))
                    second = workers.submit(server.user_token_fresh)
                    self.assertTrue(lock.waiter.wait(2))
                    self.assertEqual(grant.call_count, 1)
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=2)['access_token'], 'renewed')
                self.assertEqual(second.result(timeout=2)['access_token'], 'renewed')
            self.assertEqual(grant.call_count, 1)

    def test_new_connection_wins_after_older_refresh_finishes(self):
        server.write_token({'access_token': 'old', 'refresh_token': 'old-refresh', 'expires_at': 0})
        entered, release = threading.Event(), threading.Event()
        lock = ObservedLock()
        def exchange(body):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Fixture timed out')
            return 200, {'access_token': 'old-renewed', 'expires_at': time.time() + 7200}
        request = handler()
        with patch.object(server, '_USER_TOKEN_LOCK', lock), patch.object(server, 'exchange_grant', side_effect=exchange):
            with ThreadPoolExecutor(max_workers=2) as workers:
                old = workers.submit(server.user_token_fresh)
                try:
                    self.assertTrue(entered.wait(2))
                    new = workers.submit(request.guard, lambda: (200, {'access_token': 'new-account'}), merge=False)
                    self.assertTrue(lock.waiter.wait(2))
                finally:
                    release.set()
                old.result(timeout=2)
                new.result(timeout=2)
        self.assertEqual(server.read_token(), {'access_token': 'new-account'})

    def test_failed_persistence_cannot_report_connected(self):
        request = handler()
        with patch.object(server, 'write_token', side_effect=OSError('fixture failure')):
            request.guard(lambda: (200, {'access_token': 'fixture'}), merge=False)
        self.assertEqual(request.send_json.call_args.args[1], 502)
        self.assertNotIn('connected', request.send_json.call_args.args[0])

    def test_malformed_stored_tokens_do_not_refresh_or_erase_file(self):
        for value in ([], 'bad', {'access_token': []}, {'access_token': 'fixture', 'expires_at': 'bad'}, {'access_token': 'fixture', 'expires_at': float('nan')}, {'access_token': 'fixture', 'expires_at': 10 ** 400}):
            raw = json.dumps(value)
            Path(self.token_path).write_text(raw)
            with patch.object(server, 'exchange_grant') as grant:
                self.assertIsNone(server.user_token_fresh())
                grant.assert_not_called()
            self.assertEqual(Path(self.token_path).read_text(), raw)

    def test_malformed_grants_are_rejected_without_inventing_expiry(self):
        invalid = [[], {'access_token': ''}, {'access_token': []}, {'access_token': 'fixture'},
                   *({'access_token': 'fixture', 'expires_in': expiry} for expiry in [True, -1, 0, 2.5, 'bad', 2147483648]),
                   {'access_token': 'fixture', 'expires_in': 7200, 'refresh_token': None}]
        with patch.object(server, 'client_id', return_value='fixture-id'), patch.object(server, 'client_secret', return_value='fixture-secret'):
            for response in invalid:
                with patch.object(server, 'http_post', return_value=(200, json.dumps(response))):
                    with self.assertRaises(ValueError):
                        server.exchange_grant({})
            with patch.object(server, 'http_post', return_value=(200, '{"access_token":"fixture","expires_in":"7200"}')), patch.object(server.time, 'time', return_value=100):
                self.assertEqual(server.exchange_grant({})[1]['expires_at'], 7300)

    def test_upstream_authorization_error_is_closed_and_sanitized(self):
        body = io.BytesIO(b'{"error_description":"PRIVATE-FIXTURE"}')
        failure = urllib.error.HTTPError('https://fixture', 401, 'fixture', {}, body)
        with patch.object(server, 'client_id', return_value='fixture-id'), patch.object(server, 'client_secret', return_value='fixture-secret'), patch.object(server, 'http_post', side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, 'HTTP 401') as error:
                server.exchange_grant({})
        self.assertNotIn('PRIVATE', str(error.exception))
        self.assertTrue(body.closed)


if __name__ == '__main__':
    unittest.main()
