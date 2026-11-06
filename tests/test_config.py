import json
import tempfile
import unittest
from pathlib import Path

from snapgent_bridge.config import ConfigError, ConfigStore, build_server_spec, usable_servers, valid_server_id


class ValidationTests(unittest.TestCase):
    def test_server_ids(self):
        for good in ("vscode", "my.server-1_x", "a" * 64):
            self.assertTrue(valid_server_id(good), good)
        for bad in ("", "a" * 65, "has space", "slash/x", "../up", None, 5):
            self.assertFalse(valid_server_id(bad), bad)

    def test_spec_canonical_form_and_defaults(self):
        self.assertEqual(build_server_spec("node", None, None), {"command": "node", "args": [], "env": {}})
        self.assertEqual(build_server_spec("node", ["a.js"], {"K": "v"}), {"command": "node", "args": ["a.js"], "env": {"K": "v"}})

    def test_spec_rejections(self):
        for args in (("", [], {}), ("  ", [], {}), (None, [], {}), ("n", "x", {}), ("n", [1], {}), ("n", [], []), ("n", [], {1: "a"})):
            with self.assertRaises(ConfigError, msg=args):
                build_server_spec(*args)

    def test_usable_servers_filters_bad_entries(self):
        config = {"mcpServers": {"ok": {"command": "x"}, "bad id": {"command": "x"}, "notdict": 5}}
        self.assertEqual(list(usable_servers(config)), ["ok"])
        with self.assertRaises(ConfigError):
            usable_servers({"mcpServers": []})
        with self.assertRaises(ConfigError):
            usable_servers([])


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "config.json"
        self.store = ConfigStore(self.path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_means_no_servers(self):
        self.assertEqual(self.store.load_servers(), {})

    def test_add_creates_the_file_and_is_readable_back(self):
        self.store.add_server("extra", "node", ["s.js"], {"A": "b"})
        self.assertEqual(self.store.load_servers(), {"extra": {"command": "node", "args": ["s.js"], "env": {"A": "b"}}})
        self.assertFalse(self.path.with_suffix(".json.tmp").exists(), "temp file is renamed away")

    def test_add_preserves_other_servers_and_unrelated_keys(self):
        self.path.write_text(json.dumps({"keep": 1, "mcpServers": {"vscode": {"command": "py"}}}), encoding="utf-8")
        self.store.add_server("extra", "node", [], {})
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["keep"], 1)
        self.assertEqual(sorted(data["mcpServers"]), ["extra", "vscode"])

    def test_remove(self):
        self.store.add_server("extra", "node", [], {})
        self.store.remove_server("extra")
        self.assertEqual(self.store.load_servers(), {})

    def test_the_default_server_cannot_be_removed_under_its_new_or_its_old_name_and_ids_are_checked(self):
        for server_id in ("snapgent", "vscode"):
            with self.assertRaisesRegex(ConfigError, "cannot be removed"):
                self.store.remove_server(server_id)
        with self.assertRaisesRegex(ConfigError, "Invalid MCP server id"):
            self.store.add_server("bad id", "node", [], {})
        with self.assertRaisesRegex(ConfigError, "Invalid MCP server id"):
            self.store.remove_server("../x")

    def test_invalid_spec_leaves_the_file_untouched(self):
        self.store.add_server("a", "node", [], {})
        before = self.path.read_text(encoding="utf-8")
        with self.assertRaises(ConfigError):
            self.store.add_server("b", "", [], {})
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_corrupt_file_reports_which_file(self):
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(ConfigError, "Could not read config.json"):
            self.store.load_servers()
        with self.assertRaises(ConfigError):
            self.store.add_server("a", "node", [], {})

    def test_recent_folders_are_kept_latest_first_without_repeats_and_at_most_ten(self):
        self.assertEqual(self.store.recent_folders(), [])
        for name in ("a", "b", "a"):
            self.store.remember_folder(f"/work/{name}")
        self.assertEqual(self.store.recent_folders(), ["/work/a", "/work/b"])
        for number in range(15):
            self.store.remember_folder(f"/work/p{number}")
        self.assertEqual(len(self.store.recent_folders()), 10)
        self.assertEqual(self.store.recent_folders()[0], "/work/p14")

    def test_remembering_a_folder_keeps_the_servers_and_ignores_junk(self):
        self.store.add_server("extra", "node", [], {})
        self.store.remember_folder("/work/a")
        self.store.remember_folder("")
        self.store.remember_folder(None)
        self.assertEqual(list(self.store.load_servers()), ["extra"])
        self.assertEqual(self.store.recent_folders(), ["/work/a"])

    def test_a_broken_config_has_no_recent_folders(self):
        self.path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.store.recent_folders(), [])

    def test_mcpservers_must_be_an_object(self):
        self.path.write_text(json.dumps({"mcpServers": []}), encoding="utf-8")
        with self.assertRaisesRegex(ConfigError, "mcpServers"):
            self.store.load_servers()


if __name__ == "__main__":
    unittest.main()
