#!/usr/bin/env python3
"""The one program of a release: `snapgent` runs the local bridge; `snapgent --vscode-mcp` runs the VS Code MCP server
(the bridge starts that itself, from config.json). From a git clone `bridge.py` and `vscode_mcp.py` still work on their own."""

import sys

from snapgent_bridge import launcher, settings
from snapgent_bridge.launcher import VSCODE_FLAG


def run_bridge() -> int:
    from snapgent_bridge import BRIDGE_VERSION
    from snapgent_bridge.server import main

    print(f"\n  snapgent bridge v{BRIDGE_VERSION}\n  Keep this window open while you use Snapgent.\n")
    try:
        settings.ROOT.mkdir(parents=True, exist_ok=True)
        frozen = getattr(sys, "frozen", False)
        command = sys.executable
        args = [VSCODE_FLAG] if frozen else [str(settings.ROOT / "vscode_mcp.py")]
        if launcher.configure_vscode(settings.CONFIG_PATH, command, args):
            print("  VS Code MCP configured.")
        launcher.free_port(settings.PORT, say=lambda text: print(f"  {text}"))
    except launcher.LauncherError as error:
        print(f"  ERROR: {error}", file=sys.stderr)
        return 1
    main()
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == [VSCODE_FLAG]:
        from snapgent_vscode.server import main as vscode_main
        vscode_main()
        return 0
    if argv[:1] in (["--version"], ["-V"]):
        from snapgent_bridge import BRIDGE_VERSION
        print(BRIDGE_VERSION)
        return 0
    return run_bridge()


if __name__ == "__main__":
    raise SystemExit(main())
