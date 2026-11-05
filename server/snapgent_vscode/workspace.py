"""Which folder is open in VS Code right now.

VS Code records its open windows in `storage.json`. Parsing that file is pure (and tested with
sample data); only `active_folder` touches the disk and the process list.
"""

import json
import os
import re
import subprocess
import sys
import time
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


def storage_stamp(platform: str = sys.platform, env: Optional[Mapping[str, str]] = None, home: Optional[Path] = None) -> tuple:
    """When VS Code's state files last changed: a cheap `stat`, so a cached folder can be trusted until one of them changes."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    stamp = []
    for path in storage_paths(platform, env, home):
        try:
            stamp.append(path.stat().st_mtime_ns)
        except OSError:
            stamp.append(None)
    return tuple(stamp)


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


def open_folders(
    platform: str = sys.platform,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[Path] = None,
    run: Callable = subprocess.run,
) -> List[Path]:
    """The folders VS Code has open, the last active window first (folders that no longer exist are left out)."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    if platform == "win32" and not _vscode_running_on_windows(run):
        return []
    found: List[Path] = []
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
            if candidate.is_dir() and candidate not in found:
                found.append(candidate)
    return found


def active_folder(
    platform: str = sys.platform,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[Path] = None,
    run: Callable = subprocess.run,
) -> Optional[Path]:
    """The folder of the active VS Code window, or None when VS Code is not showing one."""
    folders = open_folders(platform, env, home, run)
    return folders[0] if folders else None


def checked_folder(text: object) -> Path:
    """A folder the user typed or picked, or WorkspaceError saying what is wrong with it."""
    if not isinstance(text, str) or not text.strip():
        raise WorkspaceError("Give the full path of a folder.")
    path = Path(text.strip()).expanduser()
    if not path.is_absolute():
        raise WorkspaceError("Give the full path of a folder (it must start from the root, for example /home/me/project).")
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError) as error:
        raise WorkspaceError(f"That path cannot be used: {error}") from error
    if not resolved.is_dir():
        raise WorkspaceError(f"That folder does not exist: {resolved}")
    if resolved == Path(resolved.anchor):
        raise WorkspaceError("A whole drive or the root folder cannot be the workspace. Choose a project folder.")
    return resolved


class Workspace:
    """The workspace as the tools see it: the folder the user pinned, else the active VS Code window.

    Replaceable in tests with a fixed folder.

    The auto-detected folder is cached: finding it means reading VS Code's storage.json (and, on
    Windows, listing the processes), a cost every tool call used to pay once the model's turn was
    longer than a couple of seconds. The cache lasts while storage.json is unchanged (checked with a
    `stat`), and at most DEFAULT_CACHE_TTL_SECONDS. Pinning always invalidates it.
    """

    # How long a cached auto-detected folder stays valid. Short enough that a
    # folder change in VS Code is picked up quickly, long enough to cover a
    # burst of tool calls.
    DEFAULT_CACHE_TTL_SECONDS = 30.0

    def __init__(self, finder: Callable[[], Optional[Path]] = active_folder,
                 lister: Callable[[], List[Path]] = open_folders,
                 cache_ttl: float = DEFAULT_CACHE_TTL_SECONDS,
                 stamp: Callable[[], object] = storage_stamp) -> None:
        self._finder = finder
        self._lister = lister
        self._pinned: Optional[Path] = None
        self._cache_ttl = max(0.0, float(cache_ttl))
        self._stamp = stamp
        self._cached_stamp: object = None
        self._cached_auto: Optional[Path] = None
        self._cached_auto_expires: float = 0.0
        self._cached_auto_valid: bool = False

    @property
    def pinned(self) -> Optional[Path]:
        return self._pinned if self._pinned is not None and self._pinned.is_dir() else None

    def pin(self, text: object) -> Optional[Path]:
        """Use this folder from now on (until unpinned or the server restarts); None or empty goes back to following VS Code."""
        self._pinned = None if text is None or text == "" else checked_folder(text)
        self._invalidate_auto_cache()
        return self._pinned

    def listing(self) -> Dict[str, object]:
        """What the bar's workspace menu shows."""
        active = self._finder()
        return {
            "active": str(active) if active else None,
            "open": [str(folder) for folder in self._lister()],
            "pinned": str(self.pinned) if self.pinned else None,
        }

    def _invalidate_auto_cache(self) -> None:
        self._cached_auto_valid = False
        self._cached_auto = None
        self._cached_auto_expires = 0.0
        self._cached_stamp = None

    def _auto_folder(self) -> Optional[Path]:
        """The resolved VS Code folder, cached for a short while."""
        if self._cache_ttl <= 0:
            folder = self._finder()
            return folder.resolve() if folder is not None else None
        now = time.monotonic()
        stamp = self._stamp()
        if self._cached_auto_valid and now < self._cached_auto_expires and stamp == self._cached_stamp:
            return self._cached_auto
        folder = self._finder()
        resolved = folder.resolve() if folder is not None else None
        self._cached_auto = resolved
        self._cached_auto_valid = True
        self._cached_auto_expires = now + self._cache_ttl
        self._cached_stamp = stamp
        return resolved

    def is_open(self) -> bool:
        if self._pinned is not None:
            return self.pinned is not None
        return self._auto_folder() is not None

    def root(self) -> Path:
        if self._pinned is not None:
            if self.pinned is None:
                raise WorkspaceError(f"The chosen folder is gone: {self._pinned}. Choose another one, or go back to Auto.")
            return self.pinned.resolve()
        folder = self._auto_folder()
        if folder is None:
            raise WorkspaceError("Open a project folder in VS Code before using the VS Code MCP server.")
        return folder
