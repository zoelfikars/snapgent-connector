#!/usr/bin/env python3
"""Assemble the release folder/zip from the repository and the CI build outputs.

    python scripts/package_release.py --version 3.9.3 --extension-dist extension/dist --binaries dist-bin --out out

Everything about "what goes in a release and where" is in this file, so changing the repository
layout later means changing the tables below and nothing in the CI workflows.
"""

import argparse
import shutil
import stat
import sys
import zipfile
from pathlib import Path
from typing import List

# (source in the repository, destination in the release); folders are copied recursively.
# Everything the user runs lives in server/ with the same layout as the release, so the launchers work
# unchanged from a git clone and from the zip.
SOURCES = [
    ("server/bridge.py", "bridge.py"),
    ("server/vscode_mcp.py", "vscode_mcp.py"),
    ("server/setup-config.py", "setup-config.py"),
    ("server/setup-config.ps1", "setup-config.ps1"),
    ("server/start.bat", "start.bat"),
    ("server/Linux_Start.sh", "Linux_Start.sh"),
    ("server/MacOS_Start.command", "MacOS_Start.command"),
    ("server/snapgent_bridge", "snapgent_bridge"),
    ("server/snapgent_vscode", "snapgent_vscode"),
    ("README.md", "README.md"),
    ("CHANGELOG.md", "CHANGELOG.md"),
    ("LICENSE", "LICENSE"),
    ("assets", "assets"),
]
# Built extension folders (extension/dist/<name>) -> top-level folders of the release.
EXTENSION_TARGETS = ("chrome", "firefox")
# Windows executables built by CI.
BINARIES = ("bridge.exe", "vscode_mcp.exe")
# Double-clickable on macOS/Linux only with the execute bit.
EXECUTABLE_SUFFIXES = (".sh", ".command")
IGNORED = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


class ReleaseError(RuntimeError):
    pass


def _copy(source: Path, destination: Path) -> None:
    if not source.exists():
        raise ReleaseError(f"Missing release input: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, ignore=IGNORED)
    else:
        shutil.copy2(source, destination)


def _make_launchers_executable(folder: Path) -> None:
    for path in folder.iterdir():
        if path.is_file() and path.suffix in EXECUTABLE_SUFFIXES:
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def assemble(repo: Path, out: Path, version: str, extension_dist: Path, binaries: Path = None) -> Path:
    """Build `<out>/snapgent-v<version>/` and return it. `binaries=None` skips the .exe files (dry run)."""
    folder = out / f"snapgent-v{version}"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    for source, destination in SOURCES:
        _copy(repo / source, folder / destination)
    for name in EXTENSION_TARGETS:
        _copy(extension_dist / name, folder / name)
    if binaries is not None:
        for name in BINARIES:
            _copy(binaries / name, folder / name)
    _make_launchers_executable(folder)
    return folder


def make_zip(folder: Path) -> Path:
    """Zip `folder` (with the folder itself as the top-level entry), keeping execute bits."""
    archive = folder.parent / f"{folder.name}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(folder.parent).as_posix())
    return archive


def main(argv: List[str] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True)
    parser.add_argument("--extension-dist", type=Path, required=True, help="folder holding chrome/ and firefox/")
    parser.add_argument("--binaries", type=Path, help="folder holding bridge.exe and vscode_mcp.exe (omit for a dry run)")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    try:
        folder = assemble(args.repo, args.out, args.version, args.extension_dist, args.binaries)
    except ReleaseError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(make_zip(folder))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
