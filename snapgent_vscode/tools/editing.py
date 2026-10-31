"""Tools that change files in the workspace."""

import shutil
from typing import Any, Dict, List

from ..context import Context
from ..paths import relative, resolve_inside
from .registry import DESTRUCTIVE, WRITE, tool
from .schema import BOOL, STR

def _wrote(ctx: Context, path) -> str:
    """Record that the agent wrote `path` (see SessionState) and return its workspace-relative form."""
    rel = relative(path, ctx.root)
    ctx.session.note_write(rel)
    return rel


EDIT_ITEM = {"type": "object", "properties": {"old_text": STR, "new_text": STR}, "required": ["old_text", "new_text"]}


@tool("create_file", "Create a new file without overwriting an existing file.", {"path": STR, "content": STR}, ["path"], risk=WRITE)
def create_file(ctx: Context, path: str, content: str = "") -> str:
    target = resolve_inside(path, ctx.root)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("x", encoding="utf-8", newline="") as file:
            file.write(content)
    except FileExistsError as error:
        raise FileExistsError(f"File already exists: {path}") from error
    return f"Created {_wrote(ctx, target)}"


@tool("write_file", "Write or replace a UTF-8 text file inside the workspace.", {"path": STR, "content": STR}, ["path", "content"], risk=WRITE)
def write_file(ctx: Context, path: str, content: str) -> str:
    target = resolve_inside(path, ctx.root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Saved {_wrote(ctx, target)}"


@tool("edit_file", "Replace an exact text snippet; by default the snippet must be unique.",
      {"path": STR, "old_text": STR, "new_text": STR, "replace_all": BOOL}, ["path", "old_text", "new_text"], risk=WRITE)
def edit_file(ctx: Context, path: str, old_text: str, new_text: str, replace_all: bool = False) -> str:
    if not old_text:
        raise ValueError("old_text cannot be empty.")
    target = resolve_inside(path, ctx.root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    occurrences = content.count(old_text)
    if occurrences == 0:
        raise ValueError("The exact old_text was not found.")
    if not replace_all and occurrences != 1:
        raise ValueError(f"old_text occurs {occurrences} times; provide a unique snippet or set replace_all.")
    target.write_text(content.replace(old_text, new_text) if replace_all else content.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Updated {_wrote(ctx, target)} ({occurrences if replace_all else 1} replacement(s))"


@tool("apply_patch", "Apply several exact text replacements to one file; each old_text must match exactly once and nothing is written if any edit fails.",
      {"path": STR, "edits": {"type": "array", "items": EDIT_ITEM}}, ["path", "edits"], risk=WRITE)
def apply_patch(ctx: Context, path: str, edits: List[Dict[str, Any]]) -> str:
    if not isinstance(edits, list) or not edits:
        raise ValueError("edits must be a non-empty list.")
    target = resolve_inside(path, ctx.root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    for index, edit in enumerate(edits, start=1):
        if not isinstance(edit, dict):
            raise ValueError(f"Edit {index} must be an object with old_text and new_text.")
        old_text, new_text = edit.get("old_text"), edit.get("new_text")
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
            raise ValueError(f"Edit {index} needs a non-empty old_text and a string new_text.")
        occurrences = content.count(old_text)
        if occurrences != 1:
            raise ValueError(f"Edit {index}: old_text occurs {occurrences} times; it must match exactly once. No changes were written.")
        content = content.replace(old_text, new_text, 1)
    target.write_text(content, encoding="utf-8")  # only reached when every edit applied
    return f"Patched {_wrote(ctx, target)} ({len(edits)} edit(s))"


@tool("create_directory", "Create a directory inside the workspace.", {"path": STR}, ["path"], risk=WRITE)
def create_directory(ctx: Context, path: str) -> str:
    target = resolve_inside(path, ctx.root)
    target.mkdir(parents=True, exist_ok=True)
    return f"Directory ready: {relative(target, ctx.root)}"


def _transfer(ctx: Context, source: str, destination: str):
    """Validate a move/copy: both paths inside, source is a file, destination does not exist yet."""
    source_path = resolve_inside(source, ctx.root)
    destination_path = resolve_inside(destination, ctx.root)
    if not source_path.is_file():
        raise FileNotFoundError(f"File not found: {source}")
    if destination_path.exists():
        raise FileExistsError(f"Destination already exists: {destination}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    return source_path, destination_path


@tool("move_file", "Move a file inside the workspace without overwriting a destination.",
      {"source": STR, "destination": STR}, ["source", "destination"], risk=WRITE)
def move_file(ctx: Context, source: str, destination: str) -> str:
    source_path, destination_path = _transfer(ctx, source, destination)
    source_path.rename(destination_path)
    return f"Moved {relative(source_path, ctx.root)} to {_wrote(ctx, destination_path)}"


@tool("copy_file", "Copy a file inside the workspace without overwriting a destination.",
      {"source": STR, "destination": STR}, ["source", "destination"], risk=WRITE)
def copy_file(ctx: Context, source: str, destination: str) -> str:
    source_path, destination_path = _transfer(ctx, source, destination)
    shutil.copy2(source_path, destination_path)
    return f"Copied {relative(source_path, ctx.root)} to {_wrote(ctx, destination_path)}"


@tool("delete_file", "Delete one file inside the workspace; directories, the workspace root, and .git are refused.",
      {"path": STR}, ["path"], risk=DESTRUCTIVE)
def delete_file(ctx: Context, path: str) -> str:
    target = resolve_inside(path, ctx.root)
    if target == ctx.root or ".git" in target.relative_to(ctx.root).parts:
        raise ValueError(f"Refusing to delete protected path: {path}")
    if target.is_dir():
        raise IsADirectoryError(f"Not a file (directories are not deleted): {path}")
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    target.unlink()
    return f"Deleted {relative(target, ctx.root)}"
