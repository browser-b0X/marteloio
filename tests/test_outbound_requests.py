"""Real localhost HTTP fixtures prove redirects/proxies cannot receive keys."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class OutboundRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.received = []
        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                cls.received.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')
            do_POST = do_GET
        cls.destination = ThreadingHTTPServer(('127.0.0.1', 0), Destination)
        class Origin(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.command == 'POST':
                    self.rfile.read(int(self.headers.get('Content-Length', '0')))
                if self.path.startswith('/redirect/'):
                    self.send_response(int(self.path.rsplit('/', 1)[1]))
                    self.send_header('Location', 'http://127.0.0.1:%d/capture' % cls.destination.server_port)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                body = b'x' * int(self.path.rsplit('/', 1)[1]) if self.path.startswith('/bytes/') else b'{"ok":true}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            do_POST = do_GET
        cls.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        cls.workers = []
        for fixture in (cls.origin, cls.destination):
            worker = threading.Thread(target=lambda httpd=fixture: httpd.serve_forever(poll_interval=0.01), daemon=True)
            worker.start()
            cls.workers.append(worker)
        cls.base = 'http://127.0.0.1:%d' % cls.origin.server_port

    @classmethod
    def tearDownClass(cls):
        for fixture in (cls.origin, cls.destination):
            fixture.shutdown()
            fixture.server_close()
        for worker in cls.workers:
            worker.join(timeout=2)

    def test_authenticated_get_and_post_never_follow_redirects(self):
        self.received.clear()
        for method in ('GET', 'POST'):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(method=method, status=status):
                    with self.assertRaises(urllib.error.HTTPError) as raised:
                        if method == 'GET':
                            server.http_get(self.base + '/redirect/' + str(status), headers={'Authorization': 'Bearer fixture-only'})
                        else:
                            server.http_post(self.base + '/redirect/' + str(status), b'fixture-body', {'Authorization': 'Bearer fixture-only'})
                    self.assertEqual(raised.exception.code, status)
                    raised.exception.close()
        self.assertEqual(self.received, [])

    def test_local_request_bypasses_inherited_proxy_even_without_bypass_rules(self):
        with patch.object(server.urllib.request, 'getproxies', return_value={'http': 'http://127.0.0.1:1'}), patch.object(server.urllib.request, 'proxy_bypass', return_value=False):
            self.assertEqual(server.http_get(self.base + '/ok'), (200, '{"ok":true}'))
            self.assertEqual(server.http_post(self.base + '/ok', b'{}', {}), (200, '{"ok":true}'))

    def test_upstream_size_limit_rejects_large_body_but_accepts_boundary(self):
        with patch.object(server, 'MAX_UPSTREAM_BODY', 32):
            self.assertEqual(server.http_get(self.base + '/bytes/32'), (200, 'x' * 32))
            with self.assertRaisesRegex(ValueError, 'size limit'):
                server.http_get(self.base + '/bytes/33')
            with self.assertRaisesRegex(ValueError, 'size limit'):
                server.http_post(self.base + '/bytes/100', b'{}', {})


if __name__ == '__main__':
    unittest.main()
