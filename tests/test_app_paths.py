"""Version, build id, data folder and the shared .env parser (temporary folders only)."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app_paths


class AppPathsTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="marteloio-paths-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_version_file(self):
        self.assertEqual((ROOT / "VERSION").read_text(encoding="ascii"), "0.2.0\n")
        self.assertEqual(app_paths.VERSION, "0.2.0")
        self.assertEqual(app_paths.read_version(str(self.dir)), "0.0.0")
        (self.dir / "VERSION").write_text("not a version!\n")
        self.assertEqual(app_paths.read_version(str(self.dir)), "0.0.0")

    def test_build_id_hashes_the_build_files_in_order(self):
        expected = hashlib.sha256()
        for name in app_paths.BUILD_FILES:
            expected.update((ROOT / name).read_bytes())
        self.assertEqual(app_paths.build_id(str(ROOT)), expected.hexdigest()[:12])
        self.assertEqual(app_paths.BUILD_FILES, ("VERSION", "server.py", "ai_providers.py", "app_paths.py",
                                                 "launch.py", "index.html", "listing-core.js"))
        # A missing file contributes its name only.
        (self.dir / "server.py").write_bytes(b"print('fixture')\n")
        partial = hashlib.sha256()
        for name in app_paths.BUILD_FILES:
            partial.update(b"print('fixture')\n" if name == "server.py" else name.encode())
        self.assertEqual(app_paths.build_id(str(self.dir)), partial.hexdigest()[:12])
        before = app_paths.build_id(str(self.dir))
        (self.dir / "index.html").write_text("<p>updated</p>")
        self.assertNotEqual(app_paths.build_id(str(self.dir)), before)
        self.assertRegex(before, r"^[0-9a-f]{12}$")

    def test_data_folder(self):
        folder = str(self.dir)
        self.assertEqual(app_paths.data_dir(folder, {}), folder)  # ZIP or source copy
        self.assertFalse(app_paths.is_installed(folder))
        (self.dir / "marteloio-installed").write_text("")
        self.assertTrue(app_paths.is_installed(folder))
        local = os.path.join(folder, "Local")
        expected = os.path.join(local, "Marteloio")
        self.assertEqual(app_paths.data_dir(folder, {"LOCALAPPDATA": local, "XDG_DATA_HOME": local}), expected)
        override = os.path.join(folder, "override")
        self.assertEqual(app_paths.data_dir(folder, {"MARTELOIO_DATA_DIR": override, "LOCALAPPDATA": local}), override)
        # Only an absolute override counts.
        self.assertEqual(app_paths.data_dir(folder, {"MARTELOIO_DATA_DIR": "relative", "LOCALAPPDATA": local,
                                                     "XDG_DATA_HOME": local}), expected)
        self.assertEqual(Path(app_paths.APP_DIR).resolve(), ROOT)

    def test_env_parser(self):
        env = self.dir / ".env"
        self.assertEqual(app_paths.read_env_file(str(env)), {})
        env.write_bytes(("\ufeff# comment\r\n\r\nGEMINI_API_KEY=\"AIzaQuoted\"\r\n=AIzaAlone\r\n"
                         "GROQ_API_KEY = 'gsk_single' \nNO_EQUALS_SIGN\n BAD KEY=x\n1BAD=x\nEMPTY=\n"
                         "MISMATCHED=\"abc'\nONE_QUOTE=\"\nURL=http://a/b?c=d\nLATER=1\nLATER=2\n"
                         "SPLIT=a\u2028b\nOLD_MAC=1\rNEXT=2\n").encode("utf-8"))
        self.assertEqual(app_paths.read_env_file(str(env)), {
            "GEMINI_API_KEY": "AIzaQuoted", "GROQ_API_KEY": "gsk_single", "EMPTY": "", "MISMATCHED": "\"abc'",
            "ONE_QUOTE": "\"", "URL": "http://a/b?c=d", "LATER": "2", "SPLIT": "a\u2028b", "OLD_MAC": "1", "NEXT": "2"})

    def test_env_parser_reports_unreadable_text(self):
        env = self.dir / ".env"
        env.write_bytes(b"PORT=\xff\xfe\n")
        with self.assertRaises(ValueError):
            app_paths.read_env_file(str(env))


if __name__ == "__main__":
    unittest.main()
