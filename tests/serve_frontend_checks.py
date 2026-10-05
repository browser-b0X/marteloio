"""Isolated browser regression fixture. No app import, secrets, or provider calls.

Run: python tests/serve_frontend_checks.py
Open the printed URL. Checks run against the real application DOM and scripts.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRAND_ASSETS = {"/assets/brand/marteloio-%s.png" % name for name in ("light", "dark", "light-64", "dark-64")}
FONT_ASSETS = {"/assets/fonts/%s-wght-normal.woff2" % name for name in
               ("manrope-latin", "manrope-latin-ext", "space-grotesk-latin", "space-grotesk-latin-ext")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            text = (ROOT / "index.html").read_text(encoding="utf-8")
            text = text.replace('<script id="theme-bootstrap">',
                                '<script src="/fixture.js"></script>\n<script id="theme-bootstrap">')
            body, mime = text.encode(), "text/html"
        elif path in ("/listing-core.js", "/fixture.js"):
            file = ROOT / "listing-core.js" if path == "/listing-core.js" else ROOT / "tests/frontend-regressions.js"
            body, mime = file.read_bytes(), "text/javascript"
        elif path in BRAND_ASSETS:
            body, mime = (ROOT / path[1:]).read_bytes(), "image/png"
        elif path in FONT_ASSETS:
            body, mime = (ROOT / path[1:]).read_bytes(), "font/woff2"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        binary = mime.startswith(("image/", "font/"))
        self.send_header("Content-Type", mime if binary else mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self' 'unsafe-inline' about:; connect-src 'none'; img-src 'self'; object-src 'none'")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as httpd:
        print("Browser checks: http://127.0.0.1:%d" % httpd.server_port, flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
