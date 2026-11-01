"""The operating system's own "open folder" window, so the user picks a folder instead of typing its path.

A browser page cannot learn the real path of a folder it is shown, but the bridge runs on the user's machine and can open
the system dialog. Nothing here decides whether the folder may be used; the VS Code server checks that when it is pinned.
"""

import asyncio
import os
import secrets
import shutil
import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional

from . import dbus_min

TIMEOUT_SECONDS = 600


class PickerUnavailable(RuntimeError):
    """No folder window can be opened on this machine; the message says what to install or what to do instead."""


def clean_environment(env: Dict[str, str]) -> Dict[str, str]:
    """The environment for a program the user installed: not the one a packaged `snapgent` made for itself.

    A PyInstaller program puts its own libraries first on LD_LIBRARY_PATH, which would make the system's file dialog
    load the wrong ones. PyInstaller keeps the original in LD_LIBRARY_PATH_ORIG.
    """
    fixed = dict(env)
    original = fixed.pop("LD_LIBRARY_PATH_ORIG", None)
    if original is not None:
        fixed["LD_LIBRARY_PATH"] = original
    elif getattr(sys, "frozen", False):
        fixed.pop("LD_LIBRARY_PATH", None)
    return fixed


def command_for(platform: str, start: Optional[Path], which=shutil.which) -> List[str]:
    """The command that opens the folder window and prints the chosen path."""
    where = str(start) if start else str(Path.home())
    if platform == "win32":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Choose the folder the agent works in'; "
            f"$d.SelectedPath = '{where.replace(chr(39), chr(39) * 2)}'; "
            "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
        )
        return ["powershell.exe", "-NoProfile", "-STA", "-Command", script]
    if platform == "darwin":
        return ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose the folder the agent works in")']
    if which("zenity"):
        return ["zenity", "--file-selection", "--directory", "--title=Choose the folder the agent works in", f"--filename={where.rstrip('/')}/"]
    if which("kdialog"):
        return ["kdialog", "--title", "Choose the folder the agent works in", "--getexistingdirectory", where]
    if which("yad"):
        return ["yad", "--file", "--directory", "--title=Choose the folder the agent works in", f"--filename={where.rstrip('/')}/"]
    raise PickerUnavailable("No folder window is available. Install zenity (or kdialog), or type the folder's path instead.")


async def _pick_with_portal(start: Optional[Path]) -> Optional[str]:
    """The desktop's own file chooser through xdg-desktop-portal (what GNOME, KDE and Hyprland offer, no extra program needed).

    It needs a connection that stays open until the user answers (see dbus_min.py), so it waits on a thread of its own."""
    if not os.path.exists(f"/run/user/{os.getuid()}/bus") and not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise PickerUnavailable("no desktop session bus")
    loop = asyncio.get_running_loop()
    done: "asyncio.Future" = loop.create_future()
    stop = threading.Event()
    token = "snapgent" + secrets.token_hex(6)

    def work() -> None:
        try:
            result = dbus_min.ask_portal_for_folder("Choose the folder the agent works in", token, TIMEOUT_SECONDS, stop.is_set)
            loop.call_soon_threadsafe(lambda: done.done() or done.set_result(result))
        except (dbus_min.DBusError, OSError) as error:
            loop.call_soon_threadsafe(lambda: done.done() or done.set_exception(PickerUnavailable(str(error))))

    threading.Thread(target=work, name="folder-picker", daemon=True).start()  # a daemon: a pending window must not hold the bridge open
    try:
        return await done
    finally:
        stop.set()


async def pick_folder(start: Optional[Path] = None, platform: str = sys.platform) -> Optional[str]:
    """The chosen folder, or None when the user closed the window without choosing."""
    if platform.startswith("linux"):
        try:
            return await _pick_with_portal(start)
        except (PickerUnavailable, OSError):
            pass  # no portal here: try a dialog program instead
    command = command_for(platform, start)
    try:
        process = await asyncio.create_subprocess_exec(
            *command, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env=clean_environment(dict(os.environ)),
        )
    except OSError as error:
        raise PickerUnavailable(f"The folder window could not be opened: {error}") from error
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return None
    if process.returncode != 0:  # the window was closed or cancelled
        return None
    return output.decode("utf-8", "replace").strip() or None
