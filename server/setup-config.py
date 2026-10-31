#!/usr/bin/env python3
"""Write the local Snapgent config that points the bridge at the VS Code MCP server."""

import json
import sys
from pathlib import Path
from typing import Dict, List


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
VSCODE_MCP = ROOT / "vscode_mcp.py"


def _load_config() -> Dict[str, object]:
    if not CONFIG_PATH.exists():
        return {"mcpServers": {}}
    try:
        configuration = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {CONFIG_PATH.name}: {error}") from error
    if not isinstance(configuration, dict):
        raise RuntimeError(f"{CONFIG_PATH.name} must contain a JSON object.")
    servers = configuration.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise RuntimeError(f"{CONFIG_PATH.name} must contain an object named mcpServers.")
    return configuration


def _set_server(
    servers: Dict[str, object], server_id: str, command: str, args: List[str]
) -> None:
    # Keep the user's own settings (for example the security policy in "env") across launcher runs.
    existing = servers.get(server_id)
    env = existing.get("env") if isinstance(existing, dict) and isinstance(existing.get("env"), dict) else {}
    servers[server_id] = {"command": command, "args": args, "env": env}


def _runs_bundled_server(entry: Dict[str, object]) -> bool:
    """Is this the entry we wrote ourselves (so it may be refreshed), as opposed to one the user customised?

    That includes an entry whose script path is stale because the project folder moved or was updated.
    """
    command = Path(str(entry.get("command", "")))
    if command.name in {"", "vscode_mcp.exe", "vscode_mcp.py"}:
        return True
    args = entry.get("args")
    runs_our_script = isinstance(args, list) and bool(args) and Path(str(args[0])).name == "vscode_mcp.py"
    return runs_our_script or (command.name in {"python", "python3"} and not command.exists())


def main() -> int:
    if sys.platform not in {"darwin", "linux"}:
        print("ERROR: setup-config.py supports macOS and Linux.", file=sys.stderr)
        return 1
    try:
        configuration = _load_config()
        servers = configuration["mcpServers"]
        assert isinstance(servers, dict)

        vscode = servers.get("vscode")
        if not isinstance(vscode, dict) or _runs_bundled_server(vscode):
            _set_server(servers, "vscode", sys.executable, [str(VSCODE_MCP)])
            print(f"VS Code MCP configured: {VSCODE_MCP}")

        CONFIG_PATH.write_text(
            json.dumps(configuration, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return 0
    except (OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
