"""Tools that look at files without changing them."""

import fnmatch
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List

from ..context import Context
from ..limits import IGNORED_DIRECTORIES, MAX_FILES_PER_READ, MAX_FILE_CHARS, GIT_LIST_SECONDS, MAX_LISTED_FILES, MAX_OUTPUT_CHARS, MAX_RESULTS, MAX_SEARCH_FILE_BYTES, MAX_TREE_DEPTH, SEARCH_TIME_SECONDS
from ..paths import relative, resolve_inside, walk_files
from ..process import child_environment
from ..security import TRUSTED
from ..security.files import is_sensitive
from .registry import READ, tool
from .schema import BOOL, STR, STR_LIST, integer

# Junk that is almost never useful as source context, on top of IGNORED_DIRECTORIES.
# Kept as names so it works regardless of where in the tree they appear.
DEFAULT_EXCLUDED = frozenset({
    "vendor", "node_modules", ".git", "dist", "build", "target", ".next", ".nuxt",
    "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".tox",
    ".idea", ".vscode", ".cache", "coverage", ".turbo", ".svelte-kit",
    # Toolchains and package caches that live inside a project folder in some setups, whatever the framework.
    ".rustup", ".cargo", ".gradle", ".m2", ".npm", ".pnpm-store", ".yarn", ".nuget", ".pub-cache", ".dart_tool", ".terraform",
    ".parcel-cache", ".angular", ".nx", ".expo", ".sass-cache", ".bundle", ".stack-work", ".eggs", "__pypackages__", "site-packages",
    "bower_components", "Pods", "DerivedData", "elm-stuff",
})
# Never hidden by .gitignore: where Plan mode keeps its plans.
ALWAYS_LISTED = ".snapgent"


def _excluded_names(exclude, only: bool = False) -> set:
    """Folder names to skip: the built-in lists plus `exclude`; with `only`, just `exclude` (the user's own list replaces the built-in one).
    `.git` is never entered either way."""
    names = {".git"} if only else set(IGNORED_DIRECTORIES) | set(DEFAULT_EXCLUDED)
    if exclude:
        for item in exclude:
            if isinstance(item, str) and item.strip():
                names.add(item.strip())
    return names


def _git_listing(ctx: Context, base: Path):
    """The files git itself counts as the project's: tracked ones, and new ones that .gitignore does not hide. None when this is not a
    git checkout (or git is missing or slow): the caller then walks the folder. .gitignore is what every framework already uses to say
    which folders are generated, so it replaces a list of names that could never be complete."""
    start = relative(base, ctx.root)
    command = ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"] + ([] if start == "." else ["--", start])
    try:
        done = subprocess.run(command, cwd=str(ctx.root), capture_output=True, timeout=GIT_LIST_SECONDS, env=child_environment())
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return sorted({path for path in done.stdout.decode("utf-8", errors="replace").split("\0") if path})


def _visible_files(ctx: Context, base: Path, excluded: set):
    """`(path, relative path)` of every file under `base` the agent may see. A base that is itself inside an excluded folder has none."""
    hide = ctx.policy.mode != TRUSTED
    start = relative(base, ctx.root)
    if start != "." and any(part in excluded for part in start.split("/")):
        return
    listed = _git_listing(ctx, base)
    if listed is None:
        candidates = walk_files(base, ctx.root, excluded)
    else:
        seen = set(listed)
        extra = [(path, rel) for path, rel in walk_files(ctx.root / ALWAYS_LISTED, ctx.root, excluded)
                 if rel not in seen and (start == "." or rel.startswith(f"{start}/"))] if (ctx.root / ALWAYS_LISTED).is_dir() else []
        candidates = ((ctx.root / rel, rel) for rel in listed if not any(part in excluded for part in rel.split("/")))
        candidates = _then(candidates, extra)
    for file_path, rel in candidates:
        if listed is not None and not file_path.is_file():  # removed since it was committed, or a submodule
            continue
        if hide and is_sensitive(rel):
            continue
        yield file_path, rel


def _then(first, second):
    yield from first
    yield from second


def _tree(ctx: Context, base: Path, max_depth, excluded: set) -> str:
    lines: List[str] = [str(base.name or ".")]
    count = [0]

    def walk(current: Path, depth: int, prefix: str):
        if (max_depth is not None and depth > max_depth) or count[0] >= MAX_RESULTS:
            return
        try:
            children = sorted(current.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        # Skip excluded directories and hidden secret files (non-trusted mode).
        filtered = []
        for child in children:
            if child.name in excluded:
                continue
            if child.is_file() and ctx.policy.mode != TRUSTED and is_sensitive(relative(child, ctx.root)):
                continue
            filtered.append(child)
        for index, child in enumerate(filtered):
            if count[0] >= MAX_RESULTS:
                return
            last = index == len(filtered) - 1
            branch = "└── " if last else "├── "
            lines.append(f"{prefix}{branch}{child.name}")
            count[0] += 1
            if child.is_dir():
                extension = "    " if last else "│   "
                walk(child, depth + 1, prefix + extension)

    walk(base, 0, "")
    if count[0] >= MAX_RESULTS:
        lines.append("... [truncated]")
    return "\n".join(lines)


@tool("tree", "Show a filtered tree of workspace files and folders. Junk folders are excluded by default. No depth limit by default.",
      {"path": STR, "max_depth": integer(0, MAX_TREE_DEPTH), "exclude": STR_LIST}, risk=READ)
def tree(ctx: Context, path: str = ".", max_depth: int = None, exclude: List[str] = None) -> str:
    target = resolve_inside(path, ctx.root)
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    if max_depth is not None:
        max_depth = max(0, min(int(max_depth), MAX_TREE_DEPTH))
    return _tree(ctx, target, max_depth, _excluded_names(exclude))


@tool("find_files", "Find workspace files by glob pattern.", {"path": STR, "pattern": STR, "exclude": STR_LIST, "max_results": integer(1, MAX_LISTED_FILES), "exclude_only": BOOL}, risk=READ)
def find_files(ctx: Context, path: str = ".", pattern: str = "*", exclude: List[str] = None, max_results: int = None,
               exclude_only: bool = False) -> List[str]:
    base = resolve_inside(path, ctx.root)
    if not base.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not base.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    excluded = _excluded_names(exclude, exclude_only)
    limit = MAX_RESULTS if max_results is None else max(1, min(int(max_results), MAX_LISTED_FILES))
    start = relative(base, ctx.root)
    cut = 0 if start == "." else len(start) + 1
    everything = pattern == "*"
    matches: List[str] = []
    for file_path, rel in _visible_files(ctx, base, excluded):  # stops walking the moment there is enough
        if everything or fnmatch.fnmatch(file_path.name, pattern) or fnmatch.fnmatch(rel[cut:], pattern):
            matches.append(rel)
            if len(matches) >= limit:
                break
    return matches


@tool("search_files", "Search text in workspace files. Returns compact 'path:line: text' lines.",
      {"path": STR, "query": STR, "file_pattern": STR, "case_sensitive": BOOL, "exclude": STR_LIST}, ["path", "query"], risk=READ)
def search_files(ctx: Context, path: str, query: str, file_pattern: str = "*", case_sensitive: bool = False,
                exclude: List[str] = None) -> List[str]:
    target = resolve_inside(path, ctx.root)
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not query.strip():
        raise ValueError("Search query cannot be empty.")
    needle = query if case_sensitive else query.lower()
    excluded = _excluded_names(exclude)
    matches: List[str] = []
    deadline = time.monotonic() + SEARCH_TIME_SECONDS
    for file_path, rel in ([(target, relative(target, ctx.root))] if target.is_file() else _visible_files(ctx, target, excluded)):
        if time.monotonic() >= deadline:
            matches.append(f"[search stopped after {SEARCH_TIME_SECONDS} seconds; narrow it with a smaller path or file_pattern]")
            break
        if not fnmatch.fnmatch(file_path.name, file_pattern):
            continue
        try:
            if file_path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
            with file_path.open("rb") as handle:
                data = handle.read()
        except OSError:
            continue
        if b"\0" in data[:8192]:  # a binary file
            continue
        text = data.decode("utf-8", errors="replace")
        if needle not in (text if case_sensitive else text.lower()):
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if needle in (line if case_sensitive else line.lower()):
                matches.append(f"{rel}:{line_number}: {line[:500]}")
                if len(matches) >= MAX_RESULTS:
                    return matches
    return matches


def _read(ctx: Context, path: str) -> str:
    target = resolve_inside(path, ctx.root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    return content[:MAX_FILE_CHARS] + "\n[truncated]" if len(content) > MAX_FILE_CHARS else content


@tool("read_files", f"Read up to {MAX_FILES_PER_READ} workspace files as bulk text with line numbers. "
                   f"Total output is capped; files that do not fit are listed as remaining instead of being truncated.",
      {"paths": STR_LIST, "max_total_chars": integer(1, MAX_OUTPUT_CHARS)}, ["paths"], risk=READ)
def read_files(ctx: Context, paths: List[str], max_total_chars: int = None) -> str:
    if len(paths) > MAX_FILES_PER_READ:
        raise ValueError(f"Read at most {MAX_FILES_PER_READ} files per request.")
    budget = MAX_FILE_CHARS if max_total_chars is None else max(1, min(int(max_total_chars), MAX_OUTPUT_CHARS))
    chunks: List[str] = []
    remaining: List[str] = []
    used = 0
    for path in paths:
        try:
            content = _read(ctx, path)
        except (FileNotFoundError, ValueError, OSError) as error:
            chunks.append(f"===== {path} =====\nERROR: {error}\n")
            continue
        numbered = "\n".join(f"{number}: {line}" for number, line in enumerate(content.splitlines(), start=1))
        block = f"===== {path} =====\n{numbered}\n"
        if not chunks and len(block) > budget:
            # Even the first file would overflow the budget: keep its start rather than blow the limit.
            block = block[:budget] + f"\n[cut at {budget:,} characters: this file is larger than the space left]\n"
            chunks.append(block)
            used += len(block)
        elif not chunks or used + len(block) <= budget:
            chunks.append(block)
            used += len(block)
        else:
            remaining.append(path)
    result = "".join(chunks)
    if remaining:
        result += f"\n... [{len(remaining)} more files remaining: {', '.join(remaining)}]\n"
    return result if result.strip() else "(no files read)"