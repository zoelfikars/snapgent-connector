"""The Windows side of freeing the bridge port: reading what `netstat` and `tasklist` say."""

import json
import tempfile
import unittest
from pathlib import Path

from snapgent_bridge import launcher

NETSTAT = """
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032
  TCP    127.0.0.1:17613        0.0.0.0:0              LISTENING       4321
  TCP    127.0.0.1:17613        127.0.0.1:50711        ESTABLISHED     4321
  TCP    127.0.0.1:176130       0.0.0.0:0              LISTENING       999
  TCP    [::1]:17613            [::]:0                 LISTENING       8765
  UDP    0.0.0.0:17613          *:*                                    77
"""


class WindowsOutputTests(unittest.TestCase):
    def test_only_the_programs_listening_on_exactly_that_port_are_found(self):
        self.assertEqual(launcher.parse_netstat_listeners(NETSTAT, 17613), [4321, 8765])

    def test_nothing_listening_or_nothing_said(self):
        self.assertEqual(launcher.parse_netstat_listeners(NETSTAT, 9), [])
        self.assertEqual(launcher.parse_netstat_listeners("", 17613), [])

    def test_the_program_name_comes_from_the_first_csv_field_in_lower_case(self):
        self.assertEqual(launcher.windows_image_name('"Snapgent.exe","4321","Console","1","31,000 K"\r\n'), "snapgent.exe")
        self.assertEqual(launcher.windows_image_name('"python.exe","12","Console","1","9 K"'), "python.exe")
        self.assertEqual(launcher.windows_image_name("INFO: No tasks are running which match the specified criteria."), "info: no tasks are running which match the specified criteria.")
        self.assertEqual(launcher.windows_image_name(""), "")


class ConfigureDefaultServerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "config.json"

    def servers(self):
        return json.loads(self.path.read_text(encoding="utf-8"))["mcpServers"]

    def test_a_fresh_config_gets_the_snapgent_entry(self):
        self.assertTrue(launcher.configure_default_server(self.path, "/usr/bin/python3", ["snapgent.py", "--vscode-mcp"]))
        self.assertEqual(list(self.servers()), ["snapgent"])

    def test_an_entry_an_older_version_wrote_as_vscode_moves_to_the_new_id_with_its_env(self):
        self.path.write_text(json.dumps({"mcpServers": {"vscode": {"command": "/old/snapgent", "args": ["--vscode-mcp"], "env": {"SNAPGENT_POLICY": "readonly"}}}}), encoding="utf-8")
        self.assertTrue(launcher.configure_default_server(self.path, "/new/snapgent", ["--vscode-mcp"]))
        servers = self.servers()
        self.assertEqual(list(servers), ["snapgent"])
        self.assertEqual(servers["snapgent"], {"command": "/new/snapgent", "args": ["--vscode-mcp"], "env": {"SNAPGENT_POLICY": "readonly"}})

    def test_a_customised_old_entry_is_kept_as_it_is_under_the_new_id(self):
        custom = {"command": "/my/own-server", "args": ["--x"], "env": {"A": "b"}}
        self.path.write_text(json.dumps({"mcpServers": {"vscode": custom}}), encoding="utf-8")
        self.assertFalse(launcher.configure_default_server(self.path, "/new/snapgent", ["--vscode-mcp"]))
        self.assertEqual(self.servers(), {"snapgent": custom})

    def test_both_the_new_and_the_old_flag_mark_an_entry_as_ours(self):
        for flag in ("--mcp", "--vscode-mcp"):
            self.assertTrue(launcher.runs_bundled_server({"command": "python3", "args": ["/x/snapgent.py", flag]}), flag)

    def test_other_servers_are_left_alone(self):
        self.path.write_text(json.dumps({"mcpServers": {"git": {"command": "git-mcp"}}}), encoding="utf-8")
        launcher.configure_default_server(self.path, "/new/snapgent", ["--vscode-mcp"])
        self.assertEqual(sorted(self.servers()), ["git", "snapgent"])


if __name__ == "__main__":
    unittest.main()
