"""Path rules: everything a tool touches must resolve inside the workspace root."""

import os
import re
from pathlib import Path
from typing import Iterable, Optional, Sequence, Tuple

from .limits import IGNORED_DIRECTORIES


def resolve_inside(rel_or_abs: str, root: Path) -> Path:
    """The absolute path for `rel_or_abs`, refusing anything that escapes `root` (.. or symlinks)."""
    path = Path(rel_or_abs or ".")
    if not path.is_absolute():
        path = root / path
    target = path.resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Path escapes workspace root: {rel_or_abs}") from error
    return target


WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
ALLOWED_OUTSIDE = frozenset({"/dev/null"})


def _points_outside(value: str, root: Path) -> bool:
    """Whether one argument that looks like a path leads out of `root`. Anything that does not look like a path is left alone."""
    if not value or "\n" in value or value in ALLOWED_OUTSIDE:
        return False
    if value.startswith("~") or value.startswith("/") or WINDOWS_DRIVE.match(value):
        target = Path(os.path.expanduser(value))
    elif ".." in re.split(r"[\\/]", value):
        target = root / value
    else:
        return False
    try:
        target.resolve().relative_to(root)
    except (ValueError, OSError, RuntimeError):
        return True
    return False


def find_outside_root(values: Sequence[str], root: Path) -> Optional[str]:
    """The first argument that names a place outside `root` (`--flag=/path` counts as `/path`), or None.

    A heuristic, not a sandbox: a program can still build a path itself. It stops the usual accident of a command aimed at another folder."""
    for value in values:
        text = str(value)
        candidates = [text]
        if text.startswith("-") and "=" in text:
            candidates.append(text.split("=", 1)[1])
        if any(_points_outside(candidate, root) for candidate in candidates):
            return text
    return None


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix() or "."


def iter_files(base: Path, excluded=IGNORED_DIRECTORIES) -> Iterable[Path]:
    """Files under `base`, sorted. Folders named in `excluded` (dependencies, build output) are not entered at all: walking into a
    `target/` or `node_modules/` only to throw its files away is what makes a search slow."""
    if base.is_file():
        yield base
        return
    for current, dirs, names in os.walk(base):
        dirs[:] = sorted(name for name in dirs if name not in excluded)
        for name in sorted(names):
            yield Path(current) / name


def walk_files(base: Path, root: Path, excluded=IGNORED_DIRECTORIES) -> Iterable[Tuple[Path, str]]:
    """Like iter_files, but with each file's path relative to `root` already worked out (as a string, no Path arithmetic: this
    runs once per file, and tens of thousands of files is a normal project)."""
    if base.is_file():
        yield base, relative(base, root)
        return
    root_text = str(root)
    for current, dirs, names in os.walk(base):
        dirs[:] = sorted(name for name in dirs if name not in excluded)
        inside = current[len(root_text):].replace(os.sep, "/").strip("/")
        prefix = f"{inside}/" if inside else ""
        for name in sorted(names):
            yield Path(current) / name, f"{prefix}{name}"
