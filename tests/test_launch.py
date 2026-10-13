"""Launcher regression checks: no real services, browsers or credentials."""
import contextlib
import hashlib
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app_paths
import launch


class FakeRelay:
    """A stand-in relay on a free port: /health, /session and /shutdown like the real one."""

    def __init__(self, testcase, base, app='Marteloio', build='old-build', obey=True, instance=None):
        self.shutdowns = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, data):
                body = json.dumps(data).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == '/health':
                    self.reply({'ok': True, 'app': app, 'build': build,
                                'instance': instance or launch.instance_id(base)})
                elif self.path == '/session':
                    self.reply({'token': 'fixture-session'})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                owner.shutdowns.append((self.path, self.headers.get('X-App-Token'), body,
                                        self.headers.get('Content-Type')))
                self.reply({'ok': True})
                if obey and self.headers.get('X-App-Token') == 'fixture-session':
                    threading.Thread(target=owner.close, daemon=True).start()

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        self.closed = False
        threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.01), daemon=True).start()
        testcase.addCleanup(self.close)

    def close(self):
        if not self.closed:
            self.closed = True
            self.httpd.shutdown()
            self.httpd.server_close()


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        environ = patch.dict(os.environ)
        environ.start()
        self.addCleanup(environ.stop)
        os.environ.pop('MARTELOIO_DATA_DIR', None)
        os.environ.pop('PORT', None)

    def health(self, build=None):
        return {'ok': True, 'app': 'Marteloio', 'instance': launch.instance_id(self.base),
                'build': build or app_paths.build_id(str(self.base))}

    def test_defaults_and_config_override(self):
        self.assertEqual(launch.launch_environment(self.base, {})[1], 8080)
        (self.base / '.env').write_text('# ignored\nPORT=8181\nKEY=$(do-not-execute)\n', encoding='utf-8')
        env, port = launch.launch_environment(self.base, {'PORT': '9999'})
        self.assertEqual(port, 8181)
        self.assertEqual(env['KEY'], '$(do-not-execute)')

    def test_bom_env_and_legacy_router_port_do_not_block_startup(self):
        (self.base / '.env').write_text('PORT=8181\nROUTER_PORT=8181\n', encoding='utf-8-sig')
        self.assertEqual(launch.launch_environment(self.base, {})[1], 8181)

    def test_quoted_port_and_odd_lines_are_read_like_the_server(self):
        (self.base / '.env').write_text('=AIzaPastedAlone\nPORT="8282"\nGEMINI_API_KEY=\'AIzaQuoted\'\n', encoding='utf-8')
        env, port = launch.launch_environment(self.base, {})
        self.assertEqual((port, env['GEMINI_API_KEY']), (8282, 'AIzaQuoted'))
        self.assertNotIn('', env)

    def test_invalid_or_colliding_ports_do_not_echo_values(self):
        for raw in ['0', '65536', '-1', 'SECRET', '8080 & command', '']:
            with self.assertRaises(launch.LaunchError) as error:
                launch.launch_environment(self.base, {'PORT': raw})
            self.assertEqual(str(error.exception),
                             'PORT must be a number from 1 to 65535. Fix it in the .env file, then open Marteloio again.')

    def test_health_requires_project_identity(self):
        identity = hashlib.sha256(os.path.normcase(str(self.base)).encode()).hexdigest()[:16]
        for payload, expected in [
            ({'ok': True, 'app': 'Marteloio', 'instance': identity}, True),
            ({'ok': True, 'app': 'Marteloio', 'instance': 'other'}, False),
            ({'ok': True, 'app': 'LanzaLister', 'instance': identity}, False),
            ({'ok': True}, False), ([], False), ('invalid', False),
        ]:
            response = Mock(status=200)
            response.geturl.return_value = 'http://127.0.0.1:8181/health'
            response.read.return_value = json.dumps(payload).encode()
            opener = Mock()
            opener.open.return_value.__enter__ = Mock(return_value=response)
            opener.open.return_value.__exit__ = Mock(return_value=False)
            with patch.object(launch.urllib.request, 'build_opener', return_value=opener):
                self.assertEqual(launch.project_ready(8181, self.base), expected)

    def test_same_build_reuses_the_running_app(self):
        (self.base / '.env').write_text('PORT=8181\n', encoding='utf-8')
        with patch.object(launch, 'app_health', return_value=self.health()), patch.object(launch.subprocess, 'Popen') as spawn, \
                patch.object(launch, 'stop_running') as stop, patch.object(launch.webbrowser, 'open') as browser:
            self.assertEqual(launch.launch(self.base), 0)
            spawn.assert_not_called()
            stop.assert_not_called()
            browser.assert_called_once_with('http://localhost:8181')
        self.assertFalse((self.base / 'relay.log').exists())

    def test_an_updated_build_replaces_the_running_copy(self):
        relay = FakeRelay(self, self.base, build='0.1.0-build')
        (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
        with patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch, 'wait_for_app') as wait, \
                patch.object(launch.webbrowser, 'open', return_value=True) as browser:
            self.assertEqual(launch.launch(self.base, launch.Messages(quiet=True)), 0)
        self.assertEqual(relay.shutdowns, [('/shutdown', 'fixture-session', b'{}', 'application/json')])
        spawn.assert_called_once()
        wait.assert_called_once_with(spawn.return_value, relay.port, self.base, self.base)
        browser.assert_called_once_with('http://localhost:%d' % relay.port)

    def test_the_pre_rename_relay_from_this_folder_is_replaced_too(self):
        relay = FakeRelay(self, self.base, app='LanzaLister', build=None)
        (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
        with patch.object(launch.subprocess, 'Popen'), patch.object(launch, 'wait_for_app'), \
                patch.object(launch.webbrowser, 'open', return_value=True):
            self.assertEqual(launch.launch(self.base, launch.Messages(quiet=True)), 0)
        self.assertEqual(len(relay.shutdowns), 1)

    def test_foreign_listener_refuses_start_and_browser(self):
        with patch.object(launch, 'app_health', return_value=None), patch.object(launch, 'port_occupied', return_value=True), \
                patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch.webbrowser, 'open') as browser:
            with self.assertRaisesRegex(launch.LaunchError, "couldn't start because another program is using port 8080"):
                launch.launch(self.base)
            spawn.assert_not_called()
            browser.assert_not_called()

    def test_spawn_uses_absolute_path_and_preserves_logs(self):
        (self.base / 'relay.log').write_text('previous diagnostics\n', encoding='utf-8')
        with patch.object(launch, 'app_health', return_value=None), patch.object(launch, 'port_occupied', return_value=False), \
                patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch, 'wait_for_app') as wait, \
                patch.object(launch.webbrowser, 'open'):
            launch.launch(self.base)
            self.assertEqual(spawn.call_args.args[0], [sys.executable, str(self.base / 'server.py')])
            self.assertEqual(spawn.call_args.kwargs['env']['PORT'], '8080')
            self.assertEqual(spawn.call_args.kwargs['env']['MARTELOIO_DATA_DIR'], str(self.base))
            wait.assert_called_once_with(spawn.return_value, 8080, self.base, self.base)
        self.assertEqual((self.base / 'relay.log').read_text(), 'previous diagnostics\n')

    def test_server_runs_under_the_same_interpreter(self):
        pythonw = str(self.base / 'pythonw.exe')
        with patch.object(launch.sys, 'executable', pythonw), patch.object(launch, 'app_health', return_value=None), \
                patch.object(launch, 'port_occupied', return_value=False), patch.object(launch.subprocess, 'Popen') as spawn, \
                patch.object(launch, 'wait_for_app'), patch.object(launch.webbrowser, 'open'), \
                patch.object(launch, 'message_box'):
            self.assertTrue(launch.windowless())
            launch.launch(self.base)
        self.assertEqual(spawn.call_args.args[0][0], pythonw)

    def test_big_log_is_rotated_once(self):
        log = self.base / 'relay.log'
        log.write_bytes(b'x' * (launch.LOG_LIMIT + 1))
        (self.base / 'relay.log.1').write_text('older generation\n')
        with patch.object(launch, 'app_health', return_value=None), patch.object(launch, 'port_occupied', return_value=False), \
                patch.object(launch.subprocess, 'Popen'), patch.object(launch, 'wait_for_app'), patch.object(launch.webbrowser, 'open'):
            launch.launch(self.base)
        self.assertEqual((self.base / 'relay.log.1').stat().st_size, launch.LOG_LIMIT + 1)
        self.assertEqual(log.stat().st_size, 0)
        launch.rotate_log(log)  # a small log stays where it is
        self.assertTrue(log.exists())

    def test_installed_copy_uses_its_data_folder(self):
        data = self.base / 'data'
        data.mkdir()
        (self.base / 'marteloio-installed').write_text('')
        (self.base / '.env').write_text('PORT=7001\n', encoding='utf-8')  # ignored when installed
        (data / '.env').write_text('PORT=7002\n', encoding='utf-8')
        os.environ['MARTELOIO_DATA_DIR'] = str(data)
        self.assertEqual(launch.data_folder(self.base), data)
        with patch.object(launch, 'app_health', return_value=None), patch.object(launch, 'port_occupied', return_value=False), \
                patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch, 'wait_for_app') as wait, \
                patch.object(launch.webbrowser, 'open'):
            launch.launch(self.base)
        self.assertEqual(spawn.call_args.kwargs['env']['PORT'], '7002')
        self.assertEqual(spawn.call_args.kwargs['cwd'], str(self.base))
        self.assertEqual(wait.call_args.args[3], data)
        self.assertTrue((data / 'relay.log').exists())
        self.assertFalse((self.base / 'relay.log').exists())
        del os.environ['MARTELOIO_DATA_DIR']
        local = self.base / 'local'
        self.assertEqual(Path(app_paths.data_dir(str(self.base), {'LOCALAPPDATA': str(local), 'XDG_DATA_HOME': str(local)})),
                         local / 'Marteloio')

    def test_early_exit_and_timeout(self):
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch, 'port_occupied', return_value=False):
            with self.assertRaisesRegex(launch.LaunchError, 'closed while starting. See relay.log in'):
                launch.wait_for_app(Mock(poll=Mock(return_value=1)), 8181, self.base, self.base)
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch.time, 'monotonic', side_effect=[0, 0, 31]), patch.object(launch.time, 'sleep'):
            with self.assertRaises(launch.LaunchError) as error:
                launch.wait_for_app(Mock(poll=Mock(return_value=None)), 8181, self.base, self.base)
        self.assertEqual(str(error.exception), 'Marteloio is taking longer than usual to start. Wait a minute, then open it again. '
                                               'If it keeps happening, see relay.log in %s.' % self.base)

    def test_startup_failure_never_opens_browser(self):
        with patch.object(launch, 'app_health', return_value=None), patch.object(launch, 'port_occupied', return_value=False), \
                patch.object(launch.subprocess, 'Popen'), patch.object(launch, 'wait_for_app', side_effect=launch.LaunchError('failed')), \
                patch.object(launch.webbrowser, 'open') as browser:
            with self.assertRaises(RuntimeError):
                launch.launch(self.base)
            browser.assert_not_called()

    def test_entrypoint_failure_exit_status(self):
        with patch.object(launch, 'launch', side_effect=OSError('SECRET')), patch('sys.stderr', new_callable=io.StringIO) as output:
            self.assertEqual(launch.main([]), 1)
            self.assertNotIn('SECRET', output.getvalue())
            self.assertIn("Marteloio couldn't start.", output.getvalue())

    def test_browser_that_does_not_open_is_a_failure_with_the_address(self):
        stderr = io.StringIO()
        with patch.object(launch, 'launch_environment', return_value=({}, 8181)), patch.object(launch, 'app_health', return_value=self.health()), \
                patch.object(launch, 'BASE_DIR', self.base), patch.object(launch.webbrowser, 'open', side_effect=launch.webbrowser.Error('none')), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(launch.main([]), 1)
        self.assertIn("your browser didn't open. Open http://localhost:8181 in your browser.", stderr.getvalue())

    def test_version_flag(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), patch.object(launch, 'launch') as start:
            self.assertEqual(launch.main(['--version']), 0)
        start.assert_not_called()
        self.assertEqual(stdout.getvalue().strip(), app_paths.VERSION)
        self.assertEqual(app_paths.VERSION, (Path(launch.__file__).parent / 'VERSION').read_text().strip())

    def test_unknown_option_is_refused(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.object(launch, 'launch') as start:
            self.assertEqual(launch.main(['--force']), 1)
        start.assert_not_called()
        self.assertIn('--stop', stderr.getvalue())

    def test_stop_asks_this_folders_copy_to_shut_down(self):
        relay = FakeRelay(self, self.base)
        (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), patch.object(launch, 'BASE_DIR', self.base):
            self.assertEqual(launch.main(['--stop']), 0)
        self.assertEqual(relay.shutdowns, [('/shutdown', 'fixture-session', b'{}', 'application/json')])
        self.assertFalse(launch.port_occupied(relay.port))
        self.assertIn('Marteloio has stopped.', stdout.getvalue())

    def test_stop_when_nothing_runs_is_success(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        (self.base / '.env').write_text('PORT=%d\n' % port, encoding='utf-8')
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(launch.stop(self.base), 0)
        self.assertIn("Marteloio isn't running.", stdout.getvalue())

    def test_stop_leaves_another_program_alone(self):
        for app, message in (('SomethingElse', 'used by another program'),
                             ('Marteloio', 'Another copy of Marteloio is running from a different folder')):
            with self.subTest(app=app):
                relay = FakeRelay(self, self.base, app=app, instance='another-folder')
                (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    self.assertEqual(launch.stop(self.base), 1)
                self.assertEqual(relay.shutdowns, [])
                self.assertTrue(launch.port_occupied(relay.port))
                self.assertIn(message, stderr.getvalue())

    def test_a_copy_from_another_folder_is_named_as_such(self):
        relay = FakeRelay(self, self.base, instance='another-folder')
        (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
        expected = ('Another copy of Marteloio is already running from a different folder. Stop it first '
                    '(Start menu \u203a Stop Marteloio, or stop.bat in that folder), then open Marteloio again.')
        stderr, box = io.StringIO(), Mock()
        with patch.object(launch, 'BASE_DIR', self.base), patch.object(launch.subprocess, 'Popen') as spawn, \
                patch.object(launch.webbrowser, 'open') as browser, contextlib.redirect_stderr(stderr):
            self.assertEqual(launch.main([]), 1)
            with patch.object(launch, 'windowless', return_value=True), patch.object(launch, 'message_box', box):
                self.assertEqual(launch.main([]), 1)
        self.assertEqual(stderr.getvalue().strip(), expected)
        box.assert_called_once_with(expected, True)
        spawn.assert_not_called()
        browser.assert_not_called()
        self.assertEqual(relay.shutdowns, [], 'the other copy is left running')

    def test_stop_reports_a_copy_that_does_not_stop(self):
        relay = FakeRelay(self, self.base, obey=False)
        (self.base / '.env').write_text('PORT=%d\n' % relay.port, encoding='utf-8')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.object(launch, 'STOP_SECONDS', 0.3):
            self.assertEqual(launch.stop(self.base), 1)
        self.assertEqual(len(relay.shutdowns), 1)
        self.assertIn("didn't stop in time", stderr.getvalue())

    def test_windowless_messages_use_message_boxes_and_quiet_hides_them(self):
        box = Mock()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(launch, 'windowless', return_value=True), contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            messages = launch.Messages(box=box)
            messages.note('progress only')
            messages.tell('Marteloio has stopped.')
            messages.tell('Something went wrong.', error=True)
            launch.Messages(quiet=True, box=box).tell('hidden', error=True)
            with patch.object(launch, 'message_box') as default_box, patch.object(launch, 'launch', side_effect=launch.LaunchError('boxed')):
                self.assertEqual(launch.main([]), 1)
                default_box.assert_called_once_with('boxed', True)
            with patch.object(launch, 'message_box') as default_box, patch.object(launch, 'stop', return_value=0):
                self.assertEqual(launch.main(['--stop', '--quiet']), 0)
                default_box.assert_not_called()
        self.assertEqual(box.call_args_list, [(('Marteloio has stopped.', False),), (('Something went wrong.', True),)])
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ('', ''))

    def test_windowless_detection(self):
        with patch.object(launch.sys, 'stdout', None):
            self.assertTrue(launch.windowless())
        with patch.object(launch.sys, 'executable', 'C:\\Python\\PythonW.EXE'):
            self.assertTrue(launch.windowless())
        with patch.object(launch.sys, 'executable', 'C:\\Python\\python.exe'):
            self.assertFalse(launch.windowless())

    def test_real_isolated_process_becomes_ready(self):
        # This temporary fixture never imports the real relay or reads its keys.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        (self.base / '.env').write_text(f'PORT={port}\n', encoding='utf-8')
        (self.base / 'server.py').write_text('''import hashlib, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({'ok': True, 'app': 'Marteloio', 'instance': hashlib.sha256(os.path.normcase(os.getcwd()).encode()).hexdigest()[:16]}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
''', encoding='utf-8')
        processes = []
        original = subprocess.Popen

        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process

        try:
            with patch.object(launch.subprocess, 'Popen', side_effect=spawn), patch.object(launch.webbrowser, 'open') as browser:
                self.assertEqual(launch.launch(self.base, launch.Messages(quiet=True)), 0)
                browser.assert_called_once_with(f'http://localhost:{port}')
                self.assertTrue(launch.project_ready(port, self.base))
        finally:
            for process in processes:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
