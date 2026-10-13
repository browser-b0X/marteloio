#!/usr/bin/env python3
"""Start Marteloio (or reuse the copy already running) and open it in the browser.

    launch.py              start or reuse the app, then open http://localhost:<port>
    launch.py --stop       stop the copy running from this folder (--quiet: no messages)
    launch.py --version    print the version

Under pythonw.exe there is no console, so messages appear as message boxes.
"""
import hashlib
import http.client
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

import app_paths

BASE_DIR = Path(app_paths.APP_DIR)
LOG_LIMIT = 1024 * 1024
START_SECONDS = 30
STOP_SECONDS = 10
RACE_SECONDS = 5  # how long to wait for the copy that won a double start to answer
# A relay from this folder, also the pre-rename one, can be stopped and replaced.
OUR_APPS = ('Marteloio', 'LanzaLister')


class LaunchError(RuntimeError):
    """A failure with a plain message for the seller."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def windowless():
    """Running under pythonw.exe: there is no console to print to."""
    return sys.stdout is None or re.split(r'[\\/]', sys.executable or '')[-1].lower() == 'pythonw.exe'


def message_box(text, error=False):
    try:
        import ctypes
        # MB_ICONWARNING or MB_ICONINFORMATION, plus MB_SETFOREGROUND.
        ctypes.windll.user32.MessageBoxW(None, text, 'Marteloio', (0x30 if error else 0x40) | 0x10000)
    except (AttributeError, OSError):
        pass  # not Windows: no message boxes (and no console either)


class Messages:
    """The console, or message boxes when there is none. `box` replaces message_box in tests."""

    def __init__(self, quiet=False, box=None):
        self.quiet = quiet
        self.box = box

    def note(self, text):
        """Progress: shown in a console only."""
        if not self.quiet and not windowless():
            print(text, flush=True)

    def tell(self, text, error=False):
        """A result the seller needs to see."""
        if self.quiet:
            return
        if windowless():
            (self.box or message_box)(text, error)
        else:
            print(text, file=sys.stderr if error else sys.stdout, flush=True)


def launch_environment(data, inherited):
    """The server's environment and port: inherited variables, then the data folder's .env."""
    env = dict(inherited)
    env.update(app_paths.read_env_file(str(Path(data) / '.env')))
    raw = env.get('PORT', '8080')
    if not re.fullmatch(r'[0-9]{1,5}', raw) or not 1 <= int(raw) <= 65535:
        raise LaunchError('PORT must be a number from 1 to 65535. Fix it in the .env file, then open Marteloio again.')
    env['PORT'] = str(int(raw))
    env.update(PYTHONIOENCODING='utf-8', PYTHONUTF8='1', PYTHONUNBUFFERED='1')
    return env, int(raw)


def instance_id(base):
    return hashlib.sha256(os.path.normcase(str(base)).encode()).hexdigest()[:16]


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def app_health(port, timeout=0.5):
    """The relay's /health answer on this port, or None."""
    url = f'http://127.0.0.1:{port}/health'
    try:
        with _opener().open(url, timeout=timeout) as response:
            if response.status != 200 or response.geturl() != url:
                return None
            data = json.loads(response.read(8192))
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return data if isinstance(data, dict) else None


def is_ours(health, base, apps=OUR_APPS):
    return (isinstance(health, dict) and health.get('ok') is True and health.get('app') in apps
            and health.get('instance') == instance_id(base))


def other_copy(health, base):
    """Marteloio itself, but started from a different folder."""
    return (isinstance(health, dict) and health.get('ok') is True and health.get('app') in OUR_APPS
            and health.get('instance') != instance_id(base))


def project_ready(port, base):
    return is_ours(app_health(port), base, ('Marteloio',))


def port_occupied(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            return True
    except OSError:
        return False


def request_json(port, path, body=None, headers=None, timeout=3):
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=body, headers=headers or {},
                                     method='GET' if body is None else 'POST')
    with _opener().open(request, timeout=timeout) as response:
        data = json.loads(response.read(8192))
    return data if isinstance(data, dict) else {}


def stop_running(port, base, wait=None):
    """Ask the copy started from `base` to shut down (never by image name or port).

    Returns 'not running', 'stopped', 'other copy' (Marteloio from another folder),
    'foreign' (another program has the port) or 'stuck'."""
    wait = STOP_SECONDS if wait is None else wait
    health = app_health(port)
    if health is None and not port_occupied(port):
        return 'not running'
    if not is_ours(health, base):
        return 'other copy' if other_copy(health, base) else 'foreign'
    try:
        token = request_json(port, '/session').get('token')
        if isinstance(token, str) and 0 < len(token) <= 512:
            request_json(port, '/shutdown', b'{}', {'Content-Type': 'application/json', 'X-App-Token': token})
    except (OSError, ValueError, http.client.HTTPException):
        pass  # judged below by whether the port frees up
    deadline = time.monotonic() + wait
    while port_occupied(port):
        if time.monotonic() >= deadline:
            return 'stuck'
        time.sleep(0.2)
    return 'stopped'


def rotate_log(path):
    """Keep one older log: a relay.log over 1 MB becomes relay.log.1."""
    try:
        if path.stat().st_size > LOG_LIMIT:
            os.replace(path, path.with_name(path.name + '.1'))
    except OSError:
        pass  # missing, or still open in another program: keep appending


def ready_soon(port, base):
    """This folder's copy answers within RACE_SECONDS while something holds the port."""
    end = time.monotonic() + RACE_SECONDS
    while port_occupied(port):
        if project_ready(port, base):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.25)
    return False


def wait_for_app(process, port, base, data, timeout=START_SECONDS):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if project_ready(port, base):
            return
        if process.poll() is not None:
            # Two starts at once: the other start's server won the port. Use it once it answers.
            if ready_soon(port, base):
                return
            raise LaunchError(f'Marteloio closed while starting. See relay.log in {data} to find out why.')
        time.sleep(0.25)
    raise LaunchError('Marteloio is taking longer than usual to start. Wait a minute, then open it again. '
                      f'If it keeps happening, see relay.log in {data}.')


def start_server(base, data, env, port):
    data.mkdir(parents=True, exist_ok=True)
    log_path = data / 'relay.log'
    rotate_log(log_path)
    options = {'cwd': str(base), 'env': dict(env, MARTELOIO_DATA_DIR=str(data)), 'stdin': subprocess.DEVNULL}
    if os.name == 'nt':
        options['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    with log_path.open('ab') as log:
        # The same interpreter: under pythonw.exe the server opens no console window either.
        process = subprocess.Popen([sys.executable, str(base / 'server.py')], stdout=log, stderr=log, **options)
    wait_for_app(process, port, base, data)


def open_browser(url, out):
    try:
        opened = webbrowser.open(url)
    except (webbrowser.Error, OSError):
        opened = False
    if opened:
        return 0
    out.tell(f"Marteloio is running, but your browser didn't open. Open {url} in your browser.", error=True)
    return 1


def data_folder(base, data=None):
    return Path(app_paths.data_dir(str(base))) if data is None else Path(data)


def busy_port_error(port, health=None, base=None):
    if other_copy(health, base):
        return LaunchError('Another copy of Marteloio is already running from a different folder. Stop it first '
                           '(Start menu \u203a Stop Marteloio, or stop.bat in that folder), then open Marteloio again.')
    return LaunchError(f"Marteloio couldn't start because another program is using port {port}. "
                       'Close that program, then open Marteloio again.')


def launch(base=BASE_DIR, out=None, data=None):
    out = out or Messages()
    data = data_folder(base, data)
    env, port = launch_environment(data, os.environ)
    url = f'http://localhost:{port}'
    health = app_health(port)
    if is_ours(health, base):
        if health.get('build') == app_paths.build_id(str(base)):
            out.note('Marteloio is already running. Opening it in your browser.')
            return open_browser(url, out)
        out.note('Marteloio was updated. Restarting it.')
        result = stop_running(port, base)
        if result in ('foreign', 'other copy'):
            raise busy_port_error(port, app_health(port), base)
        if result == 'stuck':
            raise LaunchError("The running copy of Marteloio didn't stop. Wait a minute, then open Marteloio again.")
    elif other_copy(health, base) or port_occupied(port):
        raise busy_port_error(port, health, base)
    start_server(base, data, env, port)
    out.note(f'Marteloio is ready at {url}')
    return open_browser(url, out)


def stop(base=BASE_DIR, out=None, data=None):
    out = out or Messages()
    _, port = launch_environment(data_folder(base, data), os.environ)
    result = stop_running(port, base)
    if result == 'other copy':
        out.tell('Another copy of Marteloio is running from a different folder, so nothing was stopped. Stop it '
                 'from there (Start menu \u203a Stop Marteloio, or stop.bat in that folder).', error=True)
        return 1
    if result == 'foreign':
        out.tell(f'Port {port} is used by another program, not Marteloio, so nothing was stopped.', error=True)
        return 1
    if result == 'stuck':
        out.tell("Marteloio didn't stop in time. Wait a minute and try again, or restart the computer.", error=True)
        return 1
    out.tell('Marteloio has stopped.' if result == 'stopped' else "Marteloio isn't running.")
    return 0


def main(argv=None):
    # Keep '--stop [--quiet]' and '--version' (and their exit codes) unchanged for good:
    # installed copies, including older launchers, run them when upgrading or uninstalling.
    args = sys.argv[1:] if argv is None else list(argv)
    out = Messages(quiet='--quiet' in args)
    if '--version' in args:
        if sys.stdout is not None:
            print(app_paths.VERSION)
        return 0
    if any(arg not in ('--stop', '--quiet') for arg in args):
        out.tell("Marteloio doesn't know that option. Use launch.py, launch.py --stop [--quiet] "
                 'or launch.py --version.', error=True)
        return 1
    action = 'stop' if '--stop' in args else 'start'
    try:
        return stop(BASE_DIR, out) if action == 'stop' else launch(BASE_DIR, out)
    except LaunchError as error:
        out.tell(str(error), error=True)
    except UnicodeDecodeError:
        out.tell(f"Marteloio couldn't read the .env file in {data_folder(BASE_DIR)}. "
                 'Save it as UTF-8 text, then try again.', error=True)
    except (OSError, ValueError):
        # Never show raw OS errors or .env values: they can contain keys.
        out.tell(f"Marteloio couldn't {action}. Check that {data_folder(BASE_DIR)} can be written to, "
                 'then try again.', error=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
