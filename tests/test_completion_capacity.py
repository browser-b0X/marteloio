"""AI request capacity checks using local events and mocked providers only."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def handler():
    result = server.Handler.__new__(server.Handler)
    result.read_json = lambda: {'model': 'listing-text', 'messages': [{'role': 'user', 'content': 'Fixture'}]}
    result.send_json = Mock()
    return result


class CompletionCapacityTests(unittest.TestCase):
    def test_busy_request_never_reaches_provider_and_capacity_recovers(self):
        entered = threading.Event()
        release = threading.Event()
        def provider(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Fixture was not released')
            return 'ok', 'groq', 'fixture-model'
        first, busy, later = handler(), handler(), handler()
        with patch.object(server, 'effective_provider_environment', return_value={'GROQ_API_KEY': 'fixture'}), patch.object(server, '_COMPLETION_SLOTS', threading.BoundedSemaphore(1)), patch.object(server.ai_providers, 'chat', side_effect=provider) as post:
            with ThreadPoolExecutor(max_workers=1) as workers:
                active = workers.submit(first.handle_completion)
                try:
                    self.assertTrue(entered.wait(2))
                    busy.handle_completion()
                    error, status = busy.send_json.call_args.args
                    self.assertEqual(status, 429)
                    self.assertEqual(error['kind'], 'local_busy')
                    self.assertEqual(post.call_count, 1)
                finally:
                    release.set()
                active.result(timeout=2)
            later.handle_completion()
            self.assertEqual(post.call_count, 2)
            self.assertEqual(later.send_json.call_args.args[0]['choices'][0]['message']['content'], 'ok')

    def test_failed_provider_and_failed_response_write_release_capacity(self):
        for failure, status in ((server.ai_providers.NoProvider('timeout'), 504), (server.ai_providers.NoProvider('request'), 502)):
            slots = threading.BoundedSemaphore(1)
            request = handler()
            with patch.object(server, 'effective_provider_environment', return_value={'GROQ_API_KEY': 'fixture'}), patch.object(server, '_COMPLETION_SLOTS', slots), patch.object(server.ai_providers, 'chat', side_effect=failure):
                request.handle_completion()
            self.assertEqual(request.send_json.call_args.args[1], status)
            self.assertTrue(slots.acquire(blocking=False))
        slots = threading.BoundedSemaphore(1)
        with patch.object(server, 'effective_provider_environment', return_value={'GROQ_API_KEY': 'fixture'}), patch.object(server, '_COMPLETION_SLOTS', slots), patch.object(server.ai_providers, 'chat', side_effect=RuntimeError('fixture unexpected failure')):
            with self.assertRaises(RuntimeError):
                handler().handle_completion()
        self.assertTrue(slots.acquire(blocking=False))
        slots = threading.BoundedSemaphore(1)
        request = handler()
        request.send_json.side_effect = BrokenPipeError('fixture disconnected client')
        with patch.object(server, 'effective_provider_environment', return_value={'GROQ_API_KEY': 'fixture'}), patch.object(server, '_COMPLETION_SLOTS', slots), patch.object(server.ai_providers, 'chat', return_value=('ok', 'groq', 'fixture-model')):
            with self.assertRaises(BrokenPipeError):
                request.handle_completion()
        self.assertTrue(slots.acquire(blocking=False))


if __name__ == '__main__':
    unittest.main()
