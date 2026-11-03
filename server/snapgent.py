#!/usr/bin/env python3
"""The one program: `snapgent` runs the local bridge; `snapgent --vscode-mcp` runs the VS Code MCP server (the bridge starts that
itself, from config.json). The same file runs from a clone (`python3 snapgent.py`) and, built by PyInstaller, as the release program."""

import os
import sys
from pathlib import Path

from snapgent_bridge import launcher, settings
from snapgent_bridge.launcher import VSCODE_FLAG


def run_bridge() -> int:
    from snapgent_bridge import BRIDGE_VERSION
    from snapgent_bridge.server import main

    print(f"\n  snapgent bridge v{BRIDGE_VERSION}\n  Keep this window open while you use Snapgent.\n")
    try:
        settings.ROOT.mkdir(parents=True, exist_ok=True)
        # The VS Code server is this same program again: the built program by its own name, a clone by Python and this file.
        command = sys.executable
        args = [VSCODE_FLAG] if getattr(sys, "frozen", False) else [str(Path(__file__).resolve()), VSCODE_FLAG]
        if launcher.configure_vscode(settings.CONFIG_PATH, command, args):
            print("  VS Code MCP configured.")
        launcher.free_port(settings.PORT, say=lambda text: print(f"  {text}"))
    except launcher.LauncherError as error:
        print(f"  ERROR: {error}", file=sys.stderr)
        return 1
    main()
    return 0


def _owns_its_console() -> bool:
    """Windows only: was this program started by a double-click (its own console window that closes the moment it ends)?
    Run from a terminal the console is shared with the shell. The one-file program is two processes, hence the 2."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False
    try:
        import ctypes
        processes = (ctypes.c_uint * 8)()
        return ctypes.windll.kernel32.GetConsoleProcessList(processes, 8) <= 2
    except (AttributeError, OSError):
        return False


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
    try:
        return run_bridge()
    finally:
        if _owns_its_console():  # a window that closes at once hides why the bridge stopped
            input("\n  Press Enter to close this window. ")


if __name__ == "__main__":
    raise SystemExit(main())
