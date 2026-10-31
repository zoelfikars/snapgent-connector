import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parent.parent / "server" / "setup-config.py"
SPEC = importlib.util.spec_from_file_location("setup_config", MODULE_PATH)
setup_config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_config)


class SetupConfigTests(unittest.TestCase):
    def test_linux_setup_writes_local_vscode_configuration(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ):
                result = setup_config.main()
            self.assertEqual(result, 0)
            config = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            config["mcpServers"]["vscode"]["args"],
            [str(setup_config.VSCODE_MCP)],
        )

    def test_rerunning_setup_keeps_the_users_environment_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            config_path.write_text(json.dumps({"mcpServers": {"vscode": {
                "command": "python3", "args": ["/old/vscode_mcp.py"], "env": {"SNAPGENT_POLICY": "readonly"}}}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(setup_config, "CONFIG_PATH", config_path):
                self.assertEqual(setup_config.main(), 0)
            vscode = json.loads(config_path.read_text(encoding="utf-8"))["mcpServers"]["vscode"]
        self.assertEqual(vscode["env"], {"SNAPGENT_POLICY": "readonly"})
        self.assertEqual(vscode["args"], [str(setup_config.VSCODE_MCP)], "the path itself is still refreshed")

    def _run_with(self, entry):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            config_path.write_text(json.dumps({"mcpServers": {"vscode": entry}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(setup_config, "CONFIG_PATH", config_path):
                setup_config.main()
            return json.loads(config_path.read_text(encoding="utf-8"))["mcpServers"]["vscode"]

    def test_a_stale_script_path_after_moving_the_folder_is_refreshed_even_with_a_real_python(self):
        entry = self._run_with({"command": setup_config.sys.executable, "args": ["/old/place/vscode_mcp.py"], "env": {}})
        self.assertEqual(entry["args"], [str(setup_config.VSCODE_MCP)])

    def test_an_entry_the_user_customised_is_left_alone(self):
        custom = {"command": "/opt/my-mcp/server", "args": ["--workspace", "/x"], "env": {"K": "v"}}
        self.assertEqual(self._run_with(dict(custom)), custom)


if __name__ == "__main__":
    unittest.main()
