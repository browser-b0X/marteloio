"""Where Marteloio's code and data live, its version and build id.

Shared by the relay and the launcher. A ZIP or source copy keeps its data next to
the code. The Windows installer puts a `marteloio-installed` file beside the code;
that copy keeps keys, settings and logs in %LOCALAPPDATA%\\Marteloio, so an update
can replace the code folder. MARTELOIO_DATA_DIR (an absolute path) overrides both.
Stdlib only.
"""
import hashlib
import os
import re

APP_DIR = os.path.dirname(os.path.abspath(__file__))
INSTALLED_MARKER = "marteloio-installed"
# The files that make up one build, in hashing order.
BUILD_FILES = ("VERSION", "server.py", "ai_providers.py", "app_paths.py", "launch.py",
               "index.html", "listing-core.js")
_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def read_version(app_dir=APP_DIR):
    try:
        with open(os.path.join(app_dir, "VERSION"), encoding="utf-8-sig") as handle:
            text = handle.read(64).strip()
    except OSError:
        return "0.0.0"
    return text if re.fullmatch(r"[0-9A-Za-z.+-]{1,32}", text) else "0.0.0"


def is_installed(app_dir=APP_DIR):
    return os.path.isfile(os.path.join(app_dir, INSTALLED_MARKER))


def data_dir(app_dir=APP_DIR, environ=None):
    """The folder for .env, the key store, settings.json and relay.log."""
    env = os.environ if environ is None else environ
    override = env.get("MARTELOIO_DATA_DIR", "")
    if override and os.path.isabs(override):
        return os.path.normpath(override)
    if not is_installed(app_dir):
        return app_dir
    if os.name == "nt":
        base = env.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    else:
        base = env.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "Marteloio")


def read_env_file(path):
    """KEY=value lines of a .env file as a dict. A missing file is empty.

    Blank and comment lines, lines without '=' and invalid names are skipped;
    matching quotes around a value are removed; a later line wins."""
    try:
        with open(path, encoding="utf-8-sig") as handle:
            text = handle.read()
    except FileNotFoundError:
        return {}
    values = {}
    # Universal newlines only: a U+2028 inside a value does not start a new line.
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not _ENV_KEY.fullmatch(key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def build_id(app_dir=APP_DIR):
    """First 12 hex of sha256 over the build files; a missing file adds its name only."""
    digest = hashlib.sha256()
    for name in BUILD_FILES:
        try:
            with open(os.path.join(app_dir, name), "rb") as handle:
                digest.update(handle.read())
        except OSError:
            digest.update(name.encode("ascii"))
    return digest.hexdigest()[:12]


VERSION = read_version()
INSTALLED = is_installed()
DATA_DIR = data_dir()
if DATA_DIR != APP_DIR:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        pass  # The launcher tells the seller when the folder can't be written.
