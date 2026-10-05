"""Launcher regression checks: no real services, browsers or credentials."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import launch


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_defaults_and_config_override(self):
        self.assertEqual(launch.launch_environment(self.base, {})[1], 8080)
        (self.base / '.env').write_text('# ignored\nPORT=8181\nKEY=$(do-not-execute)\n', encoding='utf-8')
        env, port = launch.launch_environment(self.base, {'PORT': '9999'})
        self.assertEqual(port, 8181)
        self.assertEqual(env['KEY'], '$(do-not-execute)')

    def test_bom_env_and_legacy_router_port_do_not_block_startup(self):
        (self.base / '.env').write_text('PORT=8181\nROUTER_PORT=8181\n', encoding='utf-8-sig')
        self.assertEqual(launch.launch_environment(self.base, {})[1], 8181)

    def test_invalid_or_colliding_ports_do_not_echo_values(self):
        for raw in ['0', '65536', '-1', 'SECRET', '8080 & command', '']:
            with self.assertRaises(RuntimeError) as error:
                launch.launch_environment(self.base, {'PORT': raw})
            self.assertEqual(str(error.exception), 'PORT must be a port number from 1 to 65535.')

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

    def test_existing_app_does_not_spawn_or_truncate_log(self):
        (self.base / '.env').write_text('PORT=8181\n', encoding='utf-8')
        with patch.object(launch, 'project_ready', return_value=True), patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch.webbrowser, 'open') as browser:
            self.assertEqual(launch.launch(self.base), 0)
            spawn.assert_not_called()
            browser.assert_called_once_with('http://localhost:8181')
        self.assertFalse((self.base / 'relay.log').exists())

    def test_foreign_listener_refuses_start_and_browser(self):
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch, 'port_occupied', return_value=True), patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch.webbrowser, 'open') as browser:
            with self.assertRaisesRegex(RuntimeError, 'occupied'):
                launch.launch(self.base)
            spawn.assert_not_called()
            browser.assert_not_called()

    def test_spawn_uses_absolute_path_and_preserves_logs(self):
        (self.base / 'relay.log').write_text('previous diagnostics\n', encoding='utf-8')
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch, 'port_occupied', return_value=False), patch.object(launch.subprocess, 'Popen') as spawn, patch.object(launch, 'wait_for_app') as wait, patch.object(launch.webbrowser, 'open'):
            launch.launch(self.base)
            self.assertEqual(spawn.call_args.args[0], [sys.executable, str(self.base / 'server.py')])
            self.assertEqual(spawn.call_args.kwargs['env']['PORT'], '8080')
            wait.assert_called_once_with(spawn.return_value, 8080, self.base)
        self.assertEqual((self.base / 'relay.log').read_text(), 'previous diagnostics\n')

    def test_early_exit_and_timeout(self):
        with patch.object(launch, 'project_ready') as ready:
            with self.assertRaisesRegex(RuntimeError, 'exited'):
                launch.wait_for_app(Mock(poll=Mock(return_value=1)), 8181, self.base)
            ready.assert_not_called()
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch.time, 'monotonic', side_effect=[0, 0, 31]), patch.object(launch.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'did not become ready'):
                launch.wait_for_app(Mock(poll=Mock(return_value=None)), 8181, self.base)

    def test_startup_failure_never_opens_browser(self):
        with patch.object(launch, 'project_ready', return_value=False), patch.object(launch, 'port_occupied', return_value=False), patch.object(launch.subprocess, 'Popen'), patch.object(launch, 'wait_for_app', side_effect=RuntimeError('failed')), patch.object(launch.webbrowser, 'open') as browser:
            with self.assertRaises(RuntimeError):
                launch.launch(self.base)
            browser.assert_not_called()

    def test_entrypoint_failure_exit_status(self):
        with patch.object(launch, 'launch', side_effect=OSError('SECRET')), patch('sys.stderr', new_callable=io.StringIO) as output:
            self.assertEqual(launch.main(), 1)
            self.assertNotIn('SECRET', output.getvalue())

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
                self.assertEqual(launch.launch(self.base), 0)
                browser.assert_called_once_with(f'http://localhost:{port}')
                self.assertTrue(launch.project_ready(port, self.base))
        finally:
            for process in processes:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
