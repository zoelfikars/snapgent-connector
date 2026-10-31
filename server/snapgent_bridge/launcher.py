"""What the single `snapgent` program does before it serves: write the config that points the bridge at the VS Code
MCP server (which is this same program run with --vscode-mcp), and free the port from an older Snapgent bridge."""

import json
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Dict, List

VSCODE_FLAG = "--vscode-mcp"
BUNDLED_NAMES = {"", "vscode_mcp.exe", "vscode_mcp.py", "vscode_mcp", "snapgent", "snapgent.exe"}


class LauncherError(RuntimeError):
    """Something the user has to fix; the message says what."""


def load_config(path: Path) -> Dict[str, object]:
    if not path.exists():
        return {"mcpServers": {}}
    try:
        configuration = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LauncherError(f"Could not read {path.name}: {error}") from error
    if not isinstance(configuration, dict):
        raise LauncherError(f"{path.name} must contain a JSON object.")
    if not isinstance(configuration.setdefault("mcpServers", {}), dict):
        raise LauncherError(f"{path.name} must contain an object named mcpServers.")
    return configuration


def runs_bundled_server(entry: Dict[str, object]) -> bool:
    """Is this the entry we wrote ourselves (so it may be refreshed), as opposed to one the user customised?

    That includes an entry whose path is stale because the folder moved or the program was updated.
    """
    command = Path(str(entry.get("command", "")))
    if command.name in BUNDLED_NAMES:
        return True
    args = entry.get("args")
    first = Path(str(args[0])).name if isinstance(args, list) and args else ""
    return first in {"vscode_mcp.py", VSCODE_FLAG} or (command.name in {"python", "python3"} and not command.exists())


def configure_vscode(config_path: Path, command: str, args: List[str]) -> bool:
    """Point the `vscode` server at `command args`, keeping the user's own env and any entry they customised.
    Returns True when the entry was written."""
    configuration = load_config(config_path)
    servers = configuration["mcpServers"]
    assert isinstance(servers, dict)
    existing = servers.get("vscode")
    written = not isinstance(existing, dict) or runs_bundled_server(existing)
    if written:
        env = existing.get("env") if isinstance(existing, dict) and isinstance(existing.get("env"), dict) else {}
        servers["vscode"] = {"command": command, "args": args, "env": env}
    config_path.write_text(json.dumps(configuration, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return written


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def _listening_pids(port: int) -> List[int]:
    lsof = shutil.which("lsof")
    if not lsof:
        return []
    result = subprocess.run([lsof, "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, check=False)
    return [int(item) for item in result.stdout.split() if item.isdigit()]


def _is_snapgent(pid: int) -> bool:
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return any(name in command for name in ("snapgent", "bridge.py", "/bridge "))


def free_port(port: int, say=print) -> None:
    """Stop an older Snapgent bridge holding the port. Anything else holding it is left alone and reported."""
    if not port_in_use(port):
        return
    pids = _listening_pids(port) if os.name == "posix" else []
    mine = [pid for pid in pids if pid != os.getpid() and _is_snapgent(pid)]
    if not pids or len(mine) != len(pids):
        raise LauncherError(f"Port {port} is already in use by another program. Close it, or set ZS_BRIDGE_PORT to another port.")
    for pid in mine:
        say(f"Replacing the previous Snapgent bridge (pid {pid})...")
        os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        if not port_in_use(port):
            return
        time.sleep(0.25)
    raise LauncherError(f"The previous Snapgent bridge did not stop; port {port} is still in use.")


