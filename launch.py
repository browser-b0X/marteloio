#!/usr/bin/env python3
"""Start the local app and open it only after project-specific readiness."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

BASE_DIR = Path(__file__).resolve().parent


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def launch_environment(base, inherited):
    env = dict(inherited)
    path = base / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            key, separator, value = line.strip().partition('=')
            key = key.strip()
            if separator and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
                env[key] = value.strip()
    raw = env.get('PORT', '8080')
    if not re.fullmatch(r'[0-9]{1,5}', raw) or not 1 <= int(raw) <= 65535:
        raise RuntimeError('PORT must be a port number from 1 to 65535.')
    env['PORT'] = str(int(raw))
    env.update(PYTHONIOENCODING='utf-8', PYTHONUTF8='1', PYTHONUNBUFFERED='1')
    return env, int(raw)


def project_ready(port, base):
    expected = hashlib.sha256(os.path.normcase(str(base)).encode()).hexdigest()[:16]
    url = f'http://127.0.0.1:{port}/health'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(url, timeout=0.5) as response:
            if response.status != 200 or response.geturl() != url:
                return False
            data = json.loads(response.read(4096))
            return isinstance(data, dict) and data.get('ok') is True and data.get('app') == 'Marteloio' and data.get('instance') == expected
    except (OSError, ValueError):
        return False


def port_occupied(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_for_app(process, port, base, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('The app exited during startup. Check relay.log for details.')
        if project_ready(port, base):
            return
        time.sleep(0.25)
    raise RuntimeError('The app did not become ready within 30 seconds. Check relay.log before retrying; it may still be starting.')


def launch(base=BASE_DIR):
    env, port = launch_environment(base, os.environ)
    if project_ready(port, base):
        print('This project is already running; opening the app.')
    else:
        if port_occupied(port):
            raise RuntimeError(f'Port {port} is occupied or the app is still starting. No second copy was started. Check relay.log or change PORT in .env.')
        options = {'cwd': str(base), 'env': env, 'stdin': subprocess.DEVNULL}
        if os.name == 'nt':
            options['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            options['start_new_session'] = True
        with (base / 'relay.log').open('ab') as log:
            process = subprocess.Popen([sys.executable, str(base / 'server.py')], stdout=log, stderr=log, **options)
        wait_for_app(process, port, base)
    url = f'http://localhost:{port}'
    print(f'App ready: {url}')
    print('Check AI provider status in the app. Log: relay.log.')
    if not webbrowser.open(url):
        print('The browser could not be opened automatically. Open the app address above.')
    return 0


def main():
    try:
        return launch()
    except RuntimeError as error:
        print(f'Startup failed: {error}', file=sys.stderr)
    except (OSError, ValueError):
        # Never print raw environment values or OS errors that might contain keys.
        print('Startup failed. Check Python, project file permissions, .env encoding, and relay.log.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
