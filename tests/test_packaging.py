"""Windows installer checks (packaging/): offline, on any OS, no Windows or Inno Setup needed.

The installer must carry every file the app serves or imports and nothing private, install
for one user without administrator rights, run the app without a console window and stop
it through launch.py instead of killing processes. The build script must use the pinned
Python embeddable package and let it import the app.
"""
import ast
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGING = ROOT / 'packaging'
FILE_LIST = PACKAGING / 'files.txt'
INSTALLER = PACKAGING / 'installer.iss'
BUILD_PS1 = PACKAGING / 'build-installer.ps1'
BUILD_CMD = PACKAGING / 'build-installer.cmd'
MARKER = PACKAGING / 'marteloio-installed'

# The Windows embeddable package the installer bundles. The hash is the one python.org lists
# for this file (the same digest is in its .sigstore bundle and SPDX SBOM). Update these
# together with the pin in packaging/build-installer.ps1, see BUILDING.md.
PINNED_PYTHON = '3.14.8'
PINNED_ZIP = 'python-3.14.8-embed-amd64.zip'
PINNED_SHA256 = 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310'
# python314._pth exactly as it comes in that zip.
PRISTINE_PTH = b'python314.zip\r\n.\r\n\r\n# Uncomment to run site.main() automatically\r\n#import site\r\n'

# Upgrades and the uninstall entry are found by this id: it must never change.
APP_ID = 'B20D620A-676B-48E8-91AD-F9B04A21EABD'

# What the shortcuts run, and the server launch.py starts with the same interpreter.
ENTRY_SCRIPTS = ('launch.py', 'server.py')
# Standard-library parts the embeddable package leaves out.
NOT_IN_EMBEDDABLE = {'tkinter', '_tkinter', 'turtle', 'turtledemo', 'idlelib', 'ensurepip', 'venv', 'test', 'lib2to3'}
PYTHONW = '{app}\\runtime\\pythonw.exe'
LAUNCHER = '"{app}\\launch.py"'


def read_file_list():
    entries = []
    for raw in FILE_LIST.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if line and not line.startswith('#'):
            entries.append(line)
    return entries


def served_files():
    """index.html, listing-core.js and every STATIC_ASSETS path server.py serves."""
    tree = ast.parse((ROOT / 'server.py').read_text(encoding='utf-8'))
    files, assets = {'index.html', 'listing-core.js'}, set()
    for node in ast.walk(tree):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(t, ast.Name) and t.id == 'STATIC_ASSETS' for t in targets):
            assets.update(path.lstrip('/') for path in ast.literal_eval(node.value))
        elif isinstance(node, ast.FunctionDef) and node.name == 'serve_index':
            names = [arg.arg for arg in node.args.args][-len(node.args.defaults):] if node.args.defaults else []
            for name, default in zip(names, node.args.defaults):
                if name == 'filename' and isinstance(default, ast.Constant):
                    files.add(default.value)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'serve_index'
              and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            files.add(node.args[0].value)
    if not assets:
        raise AssertionError('STATIC_ASSETS not found in server.py; update served_files() in this test')
    return files | assets


def top_level_imports(path):
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split('.')[0])
    return names


def app_modules():
    """(app .py files reached from the entry scripts, other top-level modules they import)."""
    scripts, others, todo = set(), set(), list(ENTRY_SCRIPTS)
    while todo:
        script = todo.pop()
        if script in scripts:
            continue
        scripts.add(script)
        for name in top_level_imports(ROOT / script):
            if (ROOT / (name + '.py')).is_file():
                todo.append(name + '.py')
            else:
                others.add(name)
    return scripts, others


def iss_sections(text):
    """{section: [lines]} of an Inno Setup script; comments and blank lines dropped."""
    sections, current = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        match = re.fullmatch(r'\[([A-Za-z]+)\]', line)
        if match:
            current = match.group(1).lower()
            sections.setdefault(current, [])
        elif current == 'code':
            sections[current].append(raw)
        elif current and line and not line.startswith((';', '#')):
            sections[current].append(line)
    return sections


def parse_entry(line):
    """One Inno Setup entry ('Name: "a"; Flags: b c') as a dict; "" inside quotes is one quote."""
    fields, i = {}, 0
    while i < len(line):
        match = re.compile(r'\s*([A-Za-z]+)\s*:\s*').match(line, i)
        if not match:
            raise ValueError('cannot parse Inno Setup entry: ' + line)
        key, i = match.group(1), match.end()
        if line.startswith('"', i):
            value, i = [], i + 1
            while True:
                end = line.index('"', i)
                value.append(line[i:end])
                if line.startswith('""', end):
                    value.append('"')
                    i = end + 2
                else:
                    i = end + 1
                    break
            value = ''.join(value)
        else:
            end = line.find(';', i)
            end = len(line) if end < 0 else end
            value, i = line[i:end].strip(), end
        fields[key] = value
        i = re.compile(r'\s*;?').match(line, i).end()
    return fields


def find_powershell():
    for name in ('powershell', 'pwsh'):   # Windows PowerShell 5.1 first, where it exists
        path = shutil.which(name)
        if path:
            return path
    return None


def run_powershell(command, env):
    shell = find_powershell()
    if not shell:
        raise unittest.SkipTest('PowerShell is not installed')
    result = subprocess.run(
        [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        capture_output=True, text=True, timeout=180, env=dict(os.environ, BUILD_PS1=str(BUILD_PS1), **env))
    if result.returncode != 0:
        raise AssertionError('PowerShell failed:\n' + result.stdout + result.stderr)
    return result.stdout


class FileListTests(unittest.TestCase):
    def test_listed_files_exist_once_and_are_plain_relative_paths(self):
        entries = read_file_list()
        self.assertTrue(entries)
        self.assertEqual(len(entries), len({entry.lower() for entry in entries}), 'duplicate entries')
        for entry in entries:
            with self.subTest(entry=entry):
                self.assertRegex(entry, r'^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$')
                self.assertTrue((ROOT / entry).is_file(), entry + ' is missing from the repository')

    def test_nothing_private_or_for_developers_is_installed(self):
        for entry in read_file_list():
            name = entry.rsplit('/', 1)[-1].lower()
            with self.subTest(entry=entry):
                self.assertNotRegex(entry, r'^(tests|docs|packaging|\.github|claude outputs)/')
                self.assertFalse(name.startswith('.'))
                self.assertNotRegex(name, r'\.(env|enc|log|pem|key|pfx|p12|bat|cmd|ps1|sh|bundle)$')
                self.assertNotRegex(name, r'secret|token|settings\.json|\.log\.|\.env\.|handoff|assessment|protocol')
                if name.endswith('.md'):
                    self.assertEqual(entry, 'TRADEMARKS.md', 'documentation stays out of the installer')

    def test_every_file_the_server_serves_is_installed(self):
        missing = served_files() - set(read_file_list())
        self.assertFalse(missing, 'served by server.py but not in packaging/files.txt: ' + ', '.join(sorted(missing)))

    def test_every_app_module_is_installed_and_the_rest_is_bundled_stdlib(self):
        scripts, others = app_modules()
        self.assertTrue({'launch.py', 'server.py', 'ai_providers.py'} <= scripts)
        missing = scripts - set(read_file_list())
        self.assertFalse(missing, 'imported at runtime but not in packaging/files.txt: ' + ', '.join(sorted(missing)))
        self.assertFalse(others - set(sys.stdlib_module_names), 'not in the standard library, so not in the bundled Python')
        self.assertFalse(others & NOT_IN_EMBEDDABLE, "the embeddable Python package doesn't include these")

    def test_installed_marker_source_is_empty(self):
        self.assertTrue(MARKER.is_file())
        self.assertEqual(MARKER.stat().st_size, 0)

    def test_build_outputs_are_not_committed(self):
        ignored = {line.strip() for line in (PACKAGING / '.gitignore').read_text(encoding='utf-8').splitlines()}
        self.assertTrue({'cache/', 'build/', 'dist/'} <= ignored)


class InstallerScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = INSTALLER.read_text(encoding='ascii')
        cls.sections = iss_sections(cls.text)
        cls.setup = {}
        for line in cls.sections['setup']:
            key, _, value = line.partition('=')
            cls.setup[key.strip().lower()] = value.strip()
        cls.code = '\n'.join(cls.sections.get('code', []))
        cls.live = '\n'.join(line for line in cls.text.splitlines()
                             if not line.strip().startswith((';', '//')))

    def entries(self, section):
        return [parse_entry(line) for line in self.sections.get(section, [])]

    def test_per_user_install_without_admin_rights(self):
        self.assertEqual(self.setup['privilegesrequired'], 'lowest')
        self.assertNotIn('privilegesrequiredoverridesallowed', self.setup)
        self.assertEqual(self.setup['defaultdirname'], '{autopf}\\Marteloio')
        admin_only = re.compile(r'\{(common\w*|pf|pf32|pf64|cf|cf32|cf64|sys|syswow64|win|dao)\}', re.I)
        self.assertIsNone(admin_only.search(self.live))
        self.assertNotRegex(self.live, r'(?i)\bHKLM|HKEY_LOCAL_MACHINE')

    def test_app_id_is_the_fixed_guid(self):
        self.assertEqual(self.setup['appid'], '{{' + APP_ID + '}')
        self.assertRegex(APP_ID, r'^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$')

    def test_setup_settings(self):
        self.assertEqual(self.setup['appversion'], '{#MyAppVersion}')
        self.assertIn('#error', self.text)   # refuses to compile without /DMyAppVersion=
        self.assertTrue(self.setup['setupiconfile'].endswith('\\assets\\brand\\marteloio.ico'))
        self.assertTrue(self.setup['compression'].startswith('lzma2'))
        self.assertEqual(self.setup['solidcompression'], 'yes')
        self.assertEqual(self.setup['wizardstyle'], 'modern')
        self.assertEqual(self.setup['outputbasefilename'], 'Marteloio-Setup')
        for page in ('disablewelcomepage', 'disabledirpage', 'disableprogramgrouppage', 'disablereadypage'):
            self.assertEqual(self.setup[page], 'yes', page)
        self.assertIn('WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall)', self.code)
        languages = self.entries('languages')
        self.assertEqual([entry['MessagesFile'] for entry in languages], ['compiler:Default.isl'])

    def test_images_come_from_the_staged_app(self):
        listed = set(read_file_list())
        staged = re.findall(r'(?m)^\w+=\{#StageDir\}\\(.+)$', self.text)
        self.assertTrue(staged)
        for path in staged:
            self.assertIn(path.replace('\\', '/'), listed)

    def test_installs_the_staged_app_and_the_marker_only(self):
        sources = sorted((entry['Source'], entry['DestDir']) for entry in self.entries('files'))
        self.assertEqual(sources, [('marteloio-installed', '{app}'), ('{#StageDir}\\*', '{app}')])
        self.assertRegex(self.text, r'(?m)^#define StageDir "build\\app"$')

    def test_shortcuts_run_the_launcher_without_a_console(self):
        icons = {entry['Name']: entry for entry in self.entries('icons')}
        self.assertEqual(set(icons), {'{group}\\Marteloio', '{group}\\Stop Marteloio', '{autodesktop}\\Marteloio'})
        for name, entry in icons.items():
            with self.subTest(name=name):
                self.assertEqual(entry['Filename'], PYTHONW)
                self.assertEqual(entry['WorkingDir'], '{app}')
                self.assertEqual(entry['IconFilename'], '{app}\\assets\\brand\\marteloio.ico')
        self.assertEqual(icons['{group}\\Marteloio']['Parameters'], LAUNCHER)
        self.assertEqual(icons['{autodesktop}\\Marteloio']['Parameters'], LAUNCHER)
        self.assertEqual(icons['{group}\\Stop Marteloio']['Parameters'], LAUNCHER + ' --stop')
        self.assertEqual(icons['{autodesktop}\\Marteloio']['Tasks'], 'desktopicon')
        tasks = {entry['Name']: entry for entry in self.entries('tasks')}
        self.assertNotIn('unchecked', tasks['desktopicon'].get('Flags', ''))   # desktop shortcut checked by default

    def test_finish_page_opens_marteloio(self):
        runs = self.entries('run')
        self.assertEqual(len(runs), 1)
        run = runs[0]
        self.assertEqual((run['Filename'], run['Parameters'], run['WorkingDir']), (PYTHONW, LAUNCHER, '{app}'))
        self.assertEqual(run['Description'], 'Open Marteloio now')
        flags = run['Flags'].split()
        self.assertTrue({'postinstall', 'nowait'} <= set(flags))
        self.assertNotIn('unchecked', flags)

    def test_running_copy_is_stopped_through_the_launcher_never_killed(self):
        for path in (INSTALLER, BUILD_PS1, BUILD_CMD):
            with self.subTest(path=path.name):
                self.assertNotRegex(path.read_text(encoding='ascii'), r'(?i)taskkill|Stop-Process|TerminateProcess|wmic')
        prepare = re.search(r'(?is)function PrepareToInstall\b.*?\nend;', self.code)
        self.assertIsNotNone(prepare, 'PrepareToInstall must stop a running copy before installing')
        for needed in ("'{app}\\runtime\\pythonw.exe'", "'{app}\\launch.py'", "' --stop --quiet'", 'FileExists', 'SW_HIDE'):
            self.assertIn(needed, prepare.group(0))
        uninstall = self.entries('uninstallrun')
        self.assertEqual(len(uninstall), 1)
        stop = uninstall[0]
        self.assertEqual((stop['Filename'], stop['Parameters']), (PYTHONW, LAUNCHER + ' --stop --quiet'))
        self.assertTrue(stop['RunOnceId'])
        self.assertTrue({'runhidden', 'waituntilterminated', 'skipifdoesntexist'} <= set(stop['Flags'].split()))

    def test_uninstall_keeps_user_data_unless_the_user_says_yes(self):
        self.assertEqual([entry['Name'] for entry in self.entries('installdelete')], ['{app}\\runtime', '{app}\\__pycache__'])
        self.assertEqual([entry['Name'] for entry in self.entries('uninstalldelete')], ['{app}\\__pycache__'])
        step = re.search(r'(?is)procedure CurUninstallStepChanged\b.*?\nend;', self.code)
        self.assertIsNotNone(step)
        body = step.group(0)
        self.assertIn("'Also remove your saved keys and settings?'", body)
        self.assertIn('MB_YESNO or MB_DEFBUTTON2', body)   # No is the default answer
        self.assertIn('not UninstallSilent', body)
        self.assertIn("ExpandConstant('{localappdata}\\Marteloio')", body)
        self.assertLess(body.index('IDYES'), body.index('DelTree'))
        self.assertEqual(self.code.count('DelTree'), 1)


class BuildScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = BUILD_PS1.read_text(encoding='ascii')

    def assignment(self, name):
        match = re.search(r"(?m)^\$" + name + r"\s*=\s*['\"]([^'\"]*)['\"]\s*$", self.text)
        self.assertIsNotNone(match, '$' + name + ' is not set in build-installer.ps1')
        return match.group(1)

    def test_pins_the_python_embeddable_package(self):
        version = self.assignment('PythonVersion')
        self.assertEqual(version, PINNED_PYTHON)
        self.assertEqual(self.assignment('PythonZipName').replace('$PythonVersion', version), PINNED_ZIP)
        self.assertEqual(self.assignment('PythonZipUrl'), 'https://www.python.org/ftp/python/$PythonVersion/$PythonZipName')
        self.assertRegex(self.assignment('PythonZipSha256'), r'^[0-9a-f]{64}$')
        self.assertEqual(self.assignment('PythonZipSha256'), PINNED_SHA256)
        self.assertIn("-notmatch '^[0-9a-f]{64}$'", self.text)   # refuses to run with a broken pin
        self.assertIn('-ne $PythonZipSha256', self.text)          # and with a file that doesn't match it

    def test_checks_the_staged_runtime_before_compiling(self):
        self.assertIn("'import ssl, ctypes, json, http.server, pyexpat, unicodedata, server, ai_providers, app_paths'", self.text)
        self.assertIn("@('-B', 'launch.py', '--version')", self.text)
        self.assertLess(self.text.index("'--version'"), self.text.index('$iscc = Find-Iscc'))
        self.assertIn('https://jrsoftware.org/isdl.php', self.text)
        for folder in ("'Inno Setup 6\\ISCC.exe'", "'Programs\\Inno Setup 6\\ISCC.exe'", '${env:ProgramFiles(x86)}', '$env:ProgramFiles', '$env:LOCALAPPDATA'):
            self.assertIn(folder, self.text)
        self.assertIn('"$hash  $SetupName`n"', self.text)
        self.assertIn("$SetupName = 'Marteloio-Setup.exe'", self.text)

    def test_pth_patch_lets_the_runtime_import_the_app(self):
        with tempfile.TemporaryDirectory() as temp:
            pth = Path(temp) / 'python314._pth'
            pth.write_bytes(PRISTINE_PTH)
            run_powershell('. $env:BUILD_PS1; Update-PthFile $env:PTH_FILE "python314.zip"; '
                           'Update-PthFile $env:PTH_FILE "python314.zip"', {'PTH_FILE': str(pth)})
            lines = pth.read_bytes().decode('ascii').split('\r\n')
        self.assertEqual(lines, ['python314.zip', '.', '..', '', '# Uncomment to run site.main() automatically', '#import site', ''])

    def test_powershell_reads_the_same_file_list(self):
        output = run_powershell('. $env:BUILD_PS1; (Read-FileList $FileListPath) -join "|"', {})
        self.assertEqual(output.strip().split('|'), read_file_list())

    def test_scripts_are_plain_ascii_and_the_wrapper_needs_no_labels(self):
        for path in (BUILD_PS1, BUILD_CMD, INSTALLER, FILE_LIST):
            with self.subTest(path=path.name):
                path.read_bytes().decode('ascii')
        wrapper = BUILD_CMD.read_text(encoding='ascii')
        self.assertNotRegex(wrapper, r'(?im)^\s*:|\bgoto\b|\bcall\s+:')   # safe with LF line endings too
        self.assertIn('build-installer.ps1', wrapper)
        self.assertIn('pause', wrapper)


if __name__ == '__main__':
    unittest.main()
