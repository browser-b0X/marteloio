"""Search coordination with fake eBay calls; no real credentials or services."""
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class SearchCoordinationTests(unittest.TestCase):
    def setUp(self):
        self.patches = [
            patch.object(server, '_SEARCH_CACHE', {}),
            patch.object(server, '_SEARCH_PENDING', {}),
            patch.object(server, '_SEARCH_GENERATION', 0),
            patch.object(server, '_SEARCH_SLOTS', threading.BoundedSemaphore(3)),
        ]
        for entry in self.patches:
            entry.start()
            self.addCleanup(entry.stop)

    def test_duplicate_queries_share_one_request_and_cache(self):
        entered, release = threading.Event(), threading.Event()
        waiting = threading.Event()

        class TrackedFuture(Future):
            def result(self, timeout=None):
                waiting.set()
                return super().result(timeout)

        def browse(query, limit):
            entered.set()
            self.assertTrue(release.wait(3))
            return {'items': [{'title': query}], 'cached': False}

        with patch.object(server, 'Future', TrackedFuture), patch.object(server, 'browse_search', side_effect=browse) as network, ThreadPoolExecutor(2) as pool:
            first = pool.submit(server.try_search, 'Camera Model-X', 20)
            try:
                self.assertTrue(entered.wait(2))
                second = pool.submit(server.try_search, ' camera   model-x ', 20)
                self.assertTrue(waiting.wait(2), 'Duplicate must join the in-flight request')
            finally:
                release.set()
            self.assertEqual(first.result(timeout=3)['items'], second.result(timeout=3)['items'])
            cached = server.try_search('CAMERA MODEL-X', 20)
            self.assertTrue(cached['cached'])
            self.assertEqual(network.call_count, 1)

    def test_unrelated_search_and_cache_hit_do_not_wait_for_slow_query(self):
        entered, release = threading.Event(), threading.Event()

        def browse(query, limit):
            if query == 'slow':
                entered.set()
                self.assertTrue(release.wait(3))
            return {'items': [{'title': query}], 'cached': False}

        with patch.object(server, 'browse_search', side_effect=browse), ThreadPoolExecutor(3) as pool:
            server.try_search('warm', 20)
            slow = pool.submit(server.try_search, 'slow', 20)
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(pool.submit(server.try_search, 'fast', 20).result(timeout=1)['items'][0]['title'], 'fast')
                self.assertTrue(pool.submit(server.try_search, 'warm', 20).result(timeout=1)['cached'])
            finally:
                release.set()
            slow.result(timeout=3)

    def test_invalidation_prevents_old_request_repopulating_cache(self):
        entered, release = threading.Event(), threading.Event()

        def browse(query, limit):
            entered.set()
            self.assertTrue(release.wait(3))
            return {'items': []}

        with patch.object(server, 'browse_search', side_effect=browse) as network, ThreadPoolExecutor(1) as pool:
            old = pool.submit(server.try_search, 'camera', 20)
            try:
                self.assertTrue(entered.wait(2))
                server.invalidate_search_cache()
            finally:
                release.set()
            old.result(timeout=3)
            self.assertEqual(server._SEARCH_CACHE, {})
            server.try_search('camera', 20)
            self.assertEqual(network.call_count, 2)

    def test_failure_releases_coordination_and_is_not_cached(self):
        with patch.object(server, 'browse_search', side_effect=[ValueError('private detail'), {'items': []}]) as network:
            failure = server.try_search('camera', 20)
            self.assertIn('error', failure)
            self.assertNotIn('private detail', str(failure))
            self.assertEqual(server._SEARCH_PENDING, {})
            self.assertEqual(server.try_search('camera', 20), {'items': []})
            self.assertEqual(network.call_count, 2)

    def test_busy_queue_is_bounded(self):
        server._SEARCH_PENDING.update({i: object() for i in range(8)})
        with patch.object(server, 'browse_search') as network:
            self.assertEqual(server.try_search('new', 20)['kind'], 'ebay_busy')
            network.assert_not_called()

    def test_capacity_failure_releases_pending_slot(self):
        with patch.object(server, '_SEARCH_SLOTS') as slots, patch.object(server, 'browse_search') as network:
            slots.acquire.return_value = False
            self.assertEqual(server.try_search('new', 20)['kind'], 'ebay_busy')
            self.assertEqual(server._SEARCH_PENDING, {})
            slots.release.assert_not_called()
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
