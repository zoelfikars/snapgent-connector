"""What the single `snapgent` program does before it serves: write the config that points the bridge at the Snapgent
MCP server (which is this same program run with --mcp), and free the port from an older Snapgent bridge."""

import json
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Dict, List

MCP_FLAG = "--mcp"
LEGACY_MCP_FLAGS = ("--vscode-mcp",)  # what the config.json of an older version holds: still understood
DEFAULT_SERVER_ID = "snapgent"
LEGACY_SERVER_ID = "vscode"  # what older versions called the default server
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
    # `vscode_mcp.py` is what older versions wrote; `snapgent.py --vscode-mcp` is what a clone writes now.
    return first in {"vscode_mcp.py", "snapgent.py", MCP_FLAG, *LEGACY_MCP_FLAGS} or (command.name in {"python", "python3"} and not command.exists())


def configure_default_server(config_path: Path, command: str, args: List[str]) -> bool:
    """Point the default (`snapgent`) server at `command args`, keeping the user's own env and any entry they customised.
    An entry an older version wrote as `vscode` becomes `snapgent`, with its env. Returns True when the entry was written."""
    configuration = load_config(config_path)
    servers = configuration["mcpServers"]
    assert isinstance(servers, dict)
    legacy = servers.pop(LEGACY_SERVER_ID, None)
    existing = servers.get(DEFAULT_SERVER_ID)
    if not isinstance(existing, dict) and isinstance(legacy, dict):
        existing = legacy  # the old entry moves to the new id, customised or not
    written = not isinstance(existing, dict) or runs_bundled_server(existing)
    if written:
        env = existing.get("env") if isinstance(existing, dict) and isinstance(existing.get("env"), dict) else {}
        servers[DEFAULT_SERVER_ID] = {"command": command, "args": args, "env": env}
    else:
        servers[DEFAULT_SERVER_ID] = existing
    config_path.write_text(json.dumps(configuration, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return written


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def _run(command: List[str]) -> str:
    """The output of a system tool, or nothing when it is missing or slow."""
    try:
        return subprocess.run(command, capture_output=True, text=True, check=False, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def parse_netstat_listeners(output: str, port: int) -> List[int]:
    """The pids listening on `port` in the output of `netstat -ano -p tcp` (Windows): `TCP  127.0.0.1:17613  0.0.0.0:0  LISTENING  4321`."""
    pids: List[int] = []
    for line in output.splitlines():
        columns = line.split()
        if len(columns) >= 5 and columns[0].upper() == "TCP" and columns[3].upper() == "LISTENING" \
                and columns[1].rsplit(":", 1)[-1] == str(port) and columns[4].isdigit():
            pids.append(int(columns[4]))
    return pids


def windows_image_name(output: str) -> str:
    """The program name in the output of `tasklist /FO CSV /NH`: `"snapgent.exe","4321","Console","1","31,000 K"`."""
    first = output.strip().splitlines()[0] if output.strip() else ""
    return first.split('","')[0].strip('"').lower()


def _listening_pids(port: int) -> List[int]:
    if os.name == "nt":
        return parse_netstat_listeners(_run(["netstat", "-ano", "-p", "tcp"]), port)
    lsof = shutil.which("lsof")
    if not lsof:
        return []
    return [int(item) for item in _run([lsof, "-ti", f"tcp:{port}", "-sTCP:LISTEN"]).split() if item.isdigit()]


def _is_snapgent(pid: int) -> bool:
    if os.name == "nt":
        image = windows_image_name(_run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"]))
        if image in ("snapgent.exe", "bridge.exe"):
            return True
        if image in ("python.exe", "pythonw.exe", "py.exe"):  # run from source: only the command line says which script
            command = _run(["powershell.exe", "-NoProfile", "-Command", f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"])
            return "bridge.py" in command or "snapgent" in command
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return any(name in command for name in ("snapgent", "bridge.py", "/bridge "))


def _stop(pid: int) -> None:
    """End a program and what it started (the MCP server is a child of the bridge)."""
    if os.name == "nt":
        _run(["taskkill", "/F", "/T", "/PID", str(pid)])
    else:
        os.kill(pid, signal.SIGTERM)


def free_port(port: int, say=print) -> None:
    """Stop an older Snapgent bridge holding the port. Anything else holding it is left alone and reported."""
    if not port_in_use(port):
        return
    pids = _listening_pids(port)
    mine = [pid for pid in pids if pid != os.getpid() and _is_snapgent(pid)]
    if not pids or len(mine) != len(pids):
        raise LauncherError(f"Port {port} is already in use by another program. Close it, or set ZS_BRIDGE_PORT to another port.")
    for pid in mine:
        say(f"Replacing the previous Snapgent bridge (pid {pid})...")
        _stop(pid)
    for _ in range(20):
        if not port_in_use(port):
            return
        time.sleep(0.25)
    raise LauncherError(f"The previous Snapgent bridge did not stop; port {port} is still in use.")


