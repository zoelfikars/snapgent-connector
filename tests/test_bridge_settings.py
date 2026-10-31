import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from snapgent_bridge import settings
from snapgent_vscode.tools import commands


class AppRootTests(unittest.TestCase):
    def test_from_source_it_is_the_folder_above_the_package(self):
        self.assertEqual(settings.app_root(False, "/x/python", "/repo/snapgent_bridge/settings.py"), Path("/repo").resolve())

    def test_inside_an_exe_it_is_the_folder_next_to_the_exe_not_the_unpack_dir(self):
        root = settings.app_root(True, "/opt/snapgent/bridge.exe", "/tmp/_MEI123/snapgent_bridge/settings.py")
        self.assertEqual(root, Path("/opt/snapgent").resolve())

    def test_the_real_root_holds_the_entry_point(self):
        self.assertTrue((settings.ROOT / "bridge.py").is_file())


class PythonInterpreterTests(unittest.TestCase):
    def test_from_source_it_is_the_running_python(self):
        self.assertEqual(commands.python_interpreter(False), sys.executable)

    def test_inside_an_exe_it_looks_on_path_and_says_so_when_missing(self):
        with patch.object(commands.shutil, "which", side_effect=lambda name: "/usr/bin/python3" if name == "python3" else None):
            self.assertEqual(commands.python_interpreter(True), "/usr/bin/python3")
        with patch.object(commands.shutil, "which", return_value=None):
            with self.assertRaisesRegex(FileNotFoundError, "Python was not found"):
                commands.python_interpreter(True)


if __name__ == "__main__":
    unittest.main()
