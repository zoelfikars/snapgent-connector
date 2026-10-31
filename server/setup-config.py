#!/usr/bin/env python3
"""Write the local Snapgent config that points the bridge at the VS Code MCP server (macOS and Linux launchers)."""

import sys
from pathlib import Path

from snapgent_bridge.launcher import LauncherError, configure_vscode

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
VSCODE_MCP = ROOT / "vscode_mcp.py"


def main() -> int:
    if sys.platform not in {"darwin", "linux"}:
        print("ERROR: setup-config.py supports macOS and Linux.", file=sys.stderr)
        return 1
    try:
        if configure_vscode(CONFIG_PATH, sys.executable, [str(VSCODE_MCP)]):
            print(f"VS Code MCP configured: {VSCODE_MCP}")
        return 0
    except (OSError, LauncherError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
