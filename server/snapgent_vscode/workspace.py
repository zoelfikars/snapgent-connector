"""Which folder is open in VS Code right now.

VS Code records its open windows in `storage.json`. Parsing that file is pure (and tested with
sample data); only `active_folder` touches the disk and the process list.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.parse import unquote, urlparse

PRODUCTS = ("Code", "Code - Insiders", "VSCodium")


class WorkspaceError(RuntimeError):
    """No usable workspace; the message tells the user what to do."""


def storage_paths(platform: str, env: Mapping[str, str], home: Path) -> List[Path]:
    """Where VS Code (and its forks) keep storage.json on this platform."""
    if platform == "win32":
        appdata = env.get("APPDATA")
        return [Path(appdata) / "Code" / "User" / "globalStorage" / "storage.json"] if appdata else []
    if platform == "linux":
        base = Path(env.get("XDG_CONFIG_HOME") or home / ".config")
    else:
        base = home / "Library" / "Application Support"
    return [base / product / "User" / "globalStorage" / "storage.json" for product in PRODUCTS]


def folder_uris(storage: Dict[str, Any]) -> List[str]:
    """Open-folder URIs, the last active window first."""
    windows = (storage or {}).get("windowsState") or {}
    uris = []
    last = (windows.get("lastActiveWindow") or {}).get("folder")
    if last:
        uris.append(last)
    uris.extend(
        folder for window in (windows.get("openedWindows") or [])
        if (folder := (window or {}).get("folder"))
    )
    return uris


def uri_to_path(uri: str, platform: str) -> Path:
    """`file:///c%3A/Users/me/app` -> `c:/Users/me/app` on Windows, `/home/me/app` elsewhere."""
    path = unquote(urlparse(uri).path)
    if platform == "win32" and re.match(r"^/[A-Za-z]:/", path):
        path = path[1:]
    return Path(path)


def _vscode_running_on_windows(run: Callable) -> bool:
    result = run(
        ["tasklist", "/FI", "IMAGENAME eq Code.exe", "/NH"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, check=False,
    )
    if result.returncode != 0:
        raise WorkspaceError("Could not check whether VS Code is running.")
    return "Code.exe" in result.stdout


def active_folder(
    platform: str = sys.platform,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[Path] = None,
    run: Callable = subprocess.run,
) -> Optional[Path]:
    """The folder of the active VS Code window, or None when VS Code is not showing one."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    if platform == "win32" and not _vscode_running_on_windows(run):
        return None
    for storage_path in storage_paths(platform, env, home):
        if not storage_path.is_file():
            continue
        try:
            data = json.loads(storage_path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError) as error:
            raise WorkspaceError(f"Could not read VS Code workspace state: {error}") from error
        for uri in folder_uris(data):
            try:
                candidate = uri_to_path(uri, platform).resolve()
            except (OSError, ValueError):
                continue
            if candidate.is_dir():
                return candidate
    return None


class Workspace:
    """The workspace as the tools see it. Replaceable in tests with a fixed folder."""

    def __init__(self, finder: Callable[[], Optional[Path]] = active_folder) -> None:
        self._finder = finder

    def is_open(self) -> bool:
        return self._finder() is not None

    def root(self) -> Path:
        folder = self._finder()
        if folder is None:
            raise WorkspaceError("Open a project folder in VS Code before using the VS Code MCP server.")
        return folder.resolve()
