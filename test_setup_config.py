import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("setup-config.py")
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


if __name__ == "__main__":
    unittest.main()
