import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from snapgent_vscode import workspace as ws


class StoragePathTests(unittest.TestCase):
    home = Path("/home/me")

    def test_linux_honours_xdg_config_home(self):
        paths = ws.storage_paths("linux", {"XDG_CONFIG_HOME": "/tmp/cfg"}, self.home)
        self.assertEqual(paths[0], Path("/tmp/cfg/Code/User/globalStorage/storage.json"))
        self.assertEqual(len(paths), 3)
        self.assertTrue(any("VSCodium" in str(p) for p in paths))

    def test_linux_defaults_to_dot_config(self):
        self.assertEqual(ws.storage_paths("linux", {}, self.home)[0], Path("/home/me/.config/Code/User/globalStorage/storage.json"))

    def test_macos(self):
        paths = ws.storage_paths("darwin", {}, self.home)
        self.assertTrue(all("Library/Application Support" in p.as_posix() for p in paths))
        self.assertTrue(any("Code - Insiders" in str(p) for p in paths))

    def test_windows_needs_appdata(self):
        self.assertEqual(ws.storage_paths("win32", {}, self.home), [])
        self.assertEqual(ws.storage_paths("win32", {"APPDATA": r"C:\Users\me\AppData\Roaming"}, self.home)[0].name, "storage.json")


class ParsingTests(unittest.TestCase):
    def test_last_active_window_comes_first_then_the_others(self):
        data = {"windowsState": {"lastActiveWindow": {"folder": "file:///a"}, "openedWindows": [{"folder": "file:///b"}, {}, None, {"folder": "file:///c"}]}}
        self.assertEqual(ws.folder_uris(data), ["file:///a", "file:///b", "file:///c"])

    def test_missing_or_empty_state(self):
        for data in ({}, None, {"windowsState": {}}, {"windowsState": {"openedWindows": [{"workspace": "x"}]}}):
            self.assertEqual(ws.folder_uris(data), [])

    def test_uris(self):
        self.assertEqual(ws.uri_to_path("file:///home/me/my%20app", "linux"), Path("/home/me/my app"))
        self.assertEqual(str(ws.uri_to_path("file:///c%3A/Users/me/app", "win32")), str(Path("c:/Users/me/app")))
        self.assertEqual(ws.uri_to_path("file:///c%3A/x", "linux"), Path("/c:/x"))  # only Windows strips the leading slash


@unittest.skipIf(sys.platform == "win32", "these simulate a Linux host with POSIX file URIs")
class ActiveFolderTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.project = self.home / "project"
        self.project.mkdir()
        self.storage = self.home / ".config/Code/User/globalStorage/storage.json"
        self.storage.parent.mkdir(parents=True)

    def folder(self, **kwargs):
        return ws.active_folder("linux", {}, self.home, **kwargs)

    def test_finds_the_open_folder(self):
        self.storage.write_text(json.dumps({"windowsState": {"lastActiveWindow": {"folder": self.project.as_uri()}}}), encoding="utf-8")
        self.assertEqual(self.folder(), self.project.resolve())

    def test_skips_folders_that_no_longer_exist(self):
        gone = self.home / "deleted"
        self.storage.write_text(json.dumps({"windowsState": {"lastActiveWindow": {"folder": gone.as_uri()}, "openedWindows": [{"folder": self.project.as_uri()}]}}), encoding="utf-8")
        self.assertEqual(self.folder(), self.project.resolve())

    def test_no_storage_file_means_no_workspace(self):
        self.assertIsNone(self.folder())

    def test_corrupt_storage_is_reported(self):
        self.storage.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(ws.WorkspaceError, "Could not read VS Code workspace state"):
            self.folder()

    def test_windows_requires_vscode_to_be_running(self):
        def run(result):
            return lambda *a, **k: SimpleNamespace(returncode=result[0], stdout=result[1])
        self.assertIsNone(ws.active_folder("win32", {"APPDATA": str(self.home)}, self.home, run=run((0, "INFO: No tasks are running"))))
        with self.assertRaisesRegex(ws.WorkspaceError, "Could not check"):
            ws.active_folder("win32", {"APPDATA": str(self.home)}, self.home, run=run((1, "")))
        storage = self.home / "Code/User/globalStorage/storage.json"
        storage.parent.mkdir(parents=True)
        storage.write_text(json.dumps({"windowsState": {"lastActiveWindow": {"folder": self.project.as_uri()}}}), encoding="utf-8")
        found = ws.active_folder("win32", {"APPDATA": str(self.home)}, self.home, run=run((0, "Code.exe  1234 Console")))
        self.assertEqual(found, self.project.resolve())


class WorkspaceObjectTests(unittest.TestCase):
    def test_open_workspace(self):
        w = ws.Workspace(lambda: Path("/tmp"))
        self.assertTrue(w.is_open())
        self.assertEqual(w.root(), Path("/tmp").resolve())

    def test_nothing_open(self):
        w = ws.Workspace(lambda: None)
        self.assertFalse(w.is_open())
        with self.assertRaisesRegex(ws.WorkspaceError, "Open a project folder in VS Code"):
            w.root()


class WorkspaceCacheTests(unittest.TestCase):
    def test_the_folder_is_not_looked_up_again_until_the_state_file_changes(self):
        calls = []
        stamp = {"value": 1}

        def finder():
            calls.append(1)
            return Path("/tmp")

        w = ws.Workspace(finder, stamp=lambda: stamp["value"])
        w.root()
        w.root()
        self.assertEqual(len(calls), 1)
        stamp["value"] = 2
        w.root()
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
