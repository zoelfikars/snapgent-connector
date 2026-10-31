"""Tools that look at files without changing them."""

import fnmatch
import os
import re
from pathlib import Path
from typing import Any, Dict, List

from ..context import Context
from ..limits import IGNORED_DIRECTORIES, MAX_FILES_PER_READ, MAX_FILE_CHARS, MAX_LINES_PER_READ, MAX_RESULTS, MAX_TREE_DEPTH
from ..paths import iter_files, relative, resolve_inside
from ..security import TRUSTED
from ..security.files import is_sensitive
from .registry import READ, tool
from .schema import BOOL, STR, STR_LIST, integer

OUTLINE_PATTERNS = (
    r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)",
    r"^\s*class\s+([A-Za-z_]\w*)",
    r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)",
)


def _visible_files(ctx: Context, base: Path):
    """Files under `base`, minus those that may hold secrets: search results and listings are sent to a
    third-party website, so they must not surface them. (Reading one is a separate, confirmed action.)"""
    hide = ctx.policy.mode != TRUSTED
    for file_path in iter_files(base):
        if hide and is_sensitive(relative(file_path, ctx.root)):
            continue
        yield file_path


def _kind(path: Path) -> str:
    return "directory" if path.is_dir() else "file"


@tool("list_dir", "List files and folders in the workspace.", {"path": STR}, risk=READ)
def list_dir(ctx: Context, path: str = ".") -> List[Dict[str, str]]:
    target = resolve_inside(path, ctx.root)
    if not target.exists():
        raise FileNotFoundError(f"Directory not found: {path}")
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    return [
        {"name": child.name, "path": relative(child, ctx.root), "type": _kind(child)}
        for child in sorted(target.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    ]


@tool("list_tree", "List a bounded tree of workspace files and folders.",
      {"path": STR, "max_depth": integer(0, MAX_TREE_DEPTH)}, risk=READ)
def list_tree(ctx: Context, path: str = ".", max_depth: int = 3) -> List[Dict[str, Any]]:
    target = resolve_inside(path, ctx.root)
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    depth_limit = max(0, min(int(max_depth), MAX_TREE_DEPTH))
    result: List[Dict[str, Any]] = []
    for current, dirs, files in os.walk(target):
        current_path = Path(current)
        depth = len(current_path.relative_to(target).parts)
        dirs[:] = sorted(name for name in dirs if name not in IGNORED_DIRECTORIES)
        for name in sorted(dirs) + sorted(files):
            entry = current_path / name
            result.append({"path": relative(entry, ctx.root), "type": _kind(entry)})
            if len(result) >= MAX_RESULTS:
                return result
        if depth >= depth_limit:
            dirs[:] = []
    return result


@tool("find_files", "Find workspace files by glob pattern.", {"path": STR, "pattern": STR}, risk=READ)
def find_files(ctx: Context, path: str = ".", pattern: str = "*") -> List[str]:
    base = resolve_inside(path, ctx.root)
    if not base.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not base.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    matches = [
        relative(file_path, ctx.root)
        for file_path in _visible_files(ctx, base)
        if fnmatch.fnmatch(file_path.name, pattern) or fnmatch.fnmatch(relative(file_path, base), pattern)
    ]
    return matches[:MAX_RESULTS]


@tool("search_files", "Search text in workspace files.",
      {"path": STR, "query": STR, "file_pattern": STR, "case_sensitive": BOOL}, ["path", "query"], risk=READ)
def search_files(ctx: Context, path: str, query: str, file_pattern: str = "*", case_sensitive: bool = False) -> List[Dict[str, Any]]:
    target = resolve_inside(path, ctx.root)
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not query.strip():
        raise ValueError("Search query cannot be empty.")
    needle = query if case_sensitive else query.lower()
    matches: List[Dict[str, Any]] = []
    for file_path in ([target] if target.is_file() else _visible_files(ctx, target)):
        if not fnmatch.fnmatch(file_path.name, file_pattern):
            continue
        try:
            text = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if needle in (line if case_sensitive else line.lower()):
                matches.append({"path": relative(file_path, ctx.root), "line": line_number, "text": line[:500]})
                if len(matches) >= MAX_RESULTS:
                    return matches
    return matches


def _read(ctx: Context, path: str) -> str:
    target = resolve_inside(path, ctx.root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    return content[:MAX_FILE_CHARS] + "\n[truncated]" if len(content) > MAX_FILE_CHARS else content


@tool("read_file", "Read a UTF-8 text file in the workspace.", {"path": STR}, ["path"], risk=READ)
def read_file(ctx: Context, path: str) -> str:
    return _read(ctx, path)


@tool("read_files", f"Read up to {MAX_FILES_PER_READ} workspace files.", {"paths": STR_LIST}, ["paths"], risk=READ)
def read_files(ctx: Context, paths: List[str]) -> List[Dict[str, str]]:
    if len(paths) > MAX_FILES_PER_READ:
        raise ValueError(f"Read at most {MAX_FILES_PER_READ} files per request.")
    return [{"path": path, "content": _read(ctx, path)} for path in paths]


@tool("read_file_lines", "Read a bounded line range from a workspace file.",
      {"path": STR, "start_line": integer(1), "end_line": integer(1)}, ["path"], risk=READ)
def read_file_lines(ctx: Context, path: str, start_line: int = 1, end_line: int = 200) -> str:
    if start_line < 1 or end_line < start_line:
        raise ValueError("Line numbers must be positive, and end_line must be >= start_line.")
    if end_line - start_line > MAX_LINES_PER_READ - 1:
        raise ValueError(f"Read at most {MAX_LINES_PER_READ} lines per request.")
    lines = _read(ctx, path).splitlines()
    return "\n".join(f"{number}: {lines[number - 1]}" for number in range(start_line, min(end_line, len(lines)) + 1))


@tool("get_file_info", "Get size, type, extension, and modification time for a workspace path.", {"path": STR}, ["path"], risk=READ)
def get_file_info(ctx: Context, path: str) -> Dict[str, Any]:
    target = resolve_inside(path, ctx.root)
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    stat = target.stat()
    return {"path": relative(target, ctx.root), "type": _kind(target), "size_bytes": stat.st_size,
            "modified": stat.st_mtime, "suffix": target.suffix}


@tool("get_file_outline", "List class and function declarations from a source file.", {"path": STR}, ["path"], risk=READ)
def get_file_outline(ctx: Context, path: str) -> List[Dict[str, Any]]:
    result = []
    for line_number, line in enumerate(_read(ctx, path).splitlines(), start=1):
        for pattern in OUTLINE_PATTERNS:
            match = re.search(pattern, line)
            if match:
                result.append({"name": match.group(1), "line": line_number})
                break
    return result[:MAX_RESULTS]
