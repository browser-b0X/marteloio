#!/usr/bin/env bash
# Readiness, .env parsing and browser opening are shared with Windows.
cd "$(dirname "$0")" || exit 1
for PY in python3 python "$HOME/AppData/Roaming/uv/python/cpython-3.14.7-windows-x86_64-none/python.exe"; do
  if command -v "$PY" >/dev/null 2>&1 && "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
    exec "$PY" "$PWD/launch.py"
  fi
done
echo "Python 3.10 or newer was not found. Install Python and try again." >&2
exit 1
