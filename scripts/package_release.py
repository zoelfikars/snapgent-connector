#!/usr/bin/env python3
"""Assemble the release files from the CI build outputs.

    python scripts/package_release.py --version 3.10.0 --extension-dist extension/dist \\
        --windows-binary dist-win/snapgent.exe --linux-binary dist-linux/snapgent --out out

A release is three files and the extension: `snapgent.exe` (Windows), `snapgent-linux-x64-v<version>.tar.gz` (Linux) and
`snapgent-extension-v<version>.zip` (the built Chrome and Firefox folders). Everything about what goes in a release is in this file,
so changing it means changing this file and nothing in the CI workflows.
"""

import argparse
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import List

# Built extension folders (extension/dist/<name>) -> top-level folders of the extension zip.
EXTENSION_TARGETS = ("chrome", "firefox")


class ReleaseError(RuntimeError):
    pass


def make_extension_zip(extension_dist: Path, out: Path, version: str) -> Path:
    """`snapgent-extension-v<version>.zip`: the built chrome/ and firefox/ folders, the same on every OS."""
    archive = out / f"snapgent-extension-v{version}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in EXTENSION_TARGETS:
            source = extension_dist / name
            if not source.is_dir():
                raise ReleaseError(f"Missing release input: {source}")
            for path in sorted(source.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(extension_dist).as_posix())
    return archive


def make_linux_archive(binary: Path, repo: Path, out: Path, version: str) -> Path:
    """`snapgent-linux-x64-v<version>.tar.gz`: the single `snapgent` program with its execute bit (a .tar.gz keeps it)."""
    if not binary.is_file():
        raise ReleaseError(f"Missing release input: {binary}")
    archive = out / f"snapgent-linux-x64-v{version}.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        info = tf.gettarinfo(str(binary), arcname="snapgent")
        info.mode = 0o755
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        with binary.open("rb") as handle:
            tf.addfile(info, handle)
        tf.add(str(repo / "LICENSE"), arcname="LICENSE")
    return archive


def copy_windows_program(binary: Path, out: Path) -> Path:
    """`snapgent.exe`, as it is: the one file a Windows user downloads and double-clicks."""
    if not binary.is_file():
        raise ReleaseError(f"Missing release input: {binary}")
    target = out / "snapgent.exe"
    shutil.copy2(binary, target)
    return target


def main(argv: List[str] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True)
    parser.add_argument("--extension-dist", type=Path, required=True, help="folder holding chrome/ and firefox/")
    parser.add_argument("--windows-binary", type=Path, help="the built snapgent.exe")
    parser.add_argument("--linux-binary", type=Path, help="the built Linux `snapgent` program")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    try:
        args.out.mkdir(parents=True, exist_ok=True)
        made = [make_extension_zip(args.extension_dist, args.out, args.version)]
        if args.windows_binary:
            made.append(copy_windows_program(args.windows_binary, args.out))
        if args.linux_binary:
            made.append(make_linux_archive(args.linux_binary, args.repo, args.out, args.version))
    except ReleaseError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    for path in made:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
