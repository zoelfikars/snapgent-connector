"""Path rules: everything a tool touches must resolve inside the workspace root."""

import os
from pathlib import Path
from typing import Iterable

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


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix() or "."


def iter_files(base: Path) -> Iterable[Path]:
    """Files under `base`, sorted, skipping dependency/build folders."""
    if base.is_file():
        yield base
        return
    for current, dirs, names in os.walk(base):
        dirs[:] = sorted(name for name in dirs if name not in IGNORED_DIRECTORIES)
        for name in sorted(names):
            yield Path(current) / name
