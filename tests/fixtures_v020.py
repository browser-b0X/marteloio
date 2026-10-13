"""Shared offline fixtures for the v0.2.0 tests: temporary data folders, a reversible
fake DPAPI, the real relay on a free local port and small fake HTTP upstreams.

Nothing here contacts a real provider or eBay, and no real key is used.
"""
import contextlib
import http.client
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

FAKE_PREFIX = b"fake-dpapi:"


def fake_encrypt(data):
    return FAKE_PREFIX + bytes(b ^ 0x5A for b in data)


def fake_decrypt(blob):
    if not blob.startswith(FAKE_PREFIX):
        raise OSError("[WinError -2146893813] Key not valid for use in specified state.")
    return bytes(b ^ 0x5A for b in blob[len(FAKE_PREFIX):])


@contextlib.contextmanager
def fake_dpapi():
    """Windows-style encrypted storage on any platform."""
    with patch.object(server, "dpapi_available", return_value=True), \
            patch.object(server, "dpapi_encrypt", side_effect=fake_encrypt), \
            patch.object(server, "dpapi_decrypt", side_effect=fake_decrypt):
        yield


class DataFolder:
    """Points every runtime file of the relay at a fresh temporary folder."""

    NAMES = {"ENV_PATH": ".env", "SECRETS_PATH": ".marteloio-secrets.enc",
             "LEGACY_SECRETS_PATH": ".lanzalister-secrets.enc", "TOKEN_PATH": ".ebay_token.json",
             "SETTINGS_PATH": "settings.json"}

    def __init__(self, testcase):
        self.path = tempfile.mkdtemp(prefix="marteloio-v020-")
        testcase.addCleanup(shutil.rmtree, self.path, True)
        for attribute, name in self.NAMES.items():
            patcher = patch.object(server, attribute, os.path.join(self.path, name), create=True)
            patcher.start()
            testcase.addCleanup(patcher.stop)
        patcher = patch.object(server, "DATA_DIR", self.path, create=True)
        patcher.start()
        testcase.addCleanup(patcher.stop)

    def file(self, name):
        return os.path.join(self.path, name)

    def names(self):
        return sorted(os.listdir(self.path))


class RunningApp:
    """The real relay handler on 127.0.0.1:<free port>."""

    def __init__(self, testcase):
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.httpd.server_address[1]
        worker = threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()

        def stop():
            self.httpd.shutdown()
            self.httpd.server_close()
            worker.join(timeout=2)
        testcase.addCleanup(stop)

    def request(self, method, path, body=None, token=True, headers=None):
        sent = {"Host": "127.0.0.1:%d" % self.port}
        if token:
            sent["X-App-Token"] = server.SESSION_TOKEN
        if body is not None:
            sent["Content-Type"] = "application/json"
            body = body if isinstance(body, bytes) else json.dumps(body).encode()
        sent.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request(method, path, body, sent)
            response = conn.getresponse()
            raw = response.read()
            try:
                data = json.loads(raw)
            except ValueError:
                data = raw
            return response.status, data
        finally:
            conn.close()


class FakeUpstream:
    """A local HTTP server whose answers a test sets per path: (status, body[, headers])."""

    def __init__(self, testcase, routes=None):
        self.routes = dict(routes or {})
        self.calls = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = raw
                owner.calls.append({"method": self.command, "path": self.path, "body": body,
                                    "authorization": self.headers.get("Authorization")})
                route = owner.routes.get(self.path)
                if isinstance(route, list):
                    route = route.pop(0) if len(route) > 1 else route[0]
                if callable(route):
                    route = route(body)
                if route is None:
                    route = (404, {"error": {"message": "no fixture route"}})
                status, payload = route[0], route[1]
                extra = route[2] if len(route) > 2 else {}
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for name, value in extra.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = answer

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.origin = "http://127.0.0.1:%d" % self.port
        worker = threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()

        def stop():
            self.httpd.shutdown()
            self.httpd.server_close()
            worker.join(timeout=2)
        testcase.addCleanup(stop)


def closed_port():
    """A local port nothing listens on (connections are refused)."""
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
