"""Git tools. Staging the whole workspace and amending are deliberately not offered."""

from typing import List

from ..context import Context
from ..limits import COMMIT_TIMEOUT_SECONDS
from ..paths import relative, resolve_inside
from ..process import run_process
from .registry import READ, VCS, tool
from .schema import STR, STR_LIST, integer


@tool("git_status", "Show the current Git branch and working-tree status.", risk=READ)
def git_status(ctx: Context) -> str:
    return run_process(["git", "status", "--short", "--branch"], ctx.root)


@tool("git_diff", "Show unstaged Git changes, optionally for one workspace path.", {"path": STR}, risk=READ)
def git_diff(ctx: Context, path: str = "") -> str:
    command = ["git", "diff", "--"]
    if path:
        command.append(relative(resolve_inside(path, ctx.root), ctx.root))
    return run_process(command, ctx.root)


@tool("git_log", "Show recent Git commits.", {"limit": integer(1, 50)}, risk=READ)
def git_log(ctx: Context, limit: int = 10) -> str:
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50.")
    return run_process(["git", "log", f"-{limit}", "--oneline", "--decorate"], ctx.root)


@tool("git_branches", "List local Git branches.", risk=READ)
def git_branches(ctx: Context) -> str:
    return run_process(["git", "branch", "--format=%(refname:short)"], ctx.root)


@tool("git_add", "Stage specific workspace paths; staging the whole workspace is refused.", {"paths": STR_LIST}, ["paths"], risk=VCS)
def git_add(ctx: Context, paths: List[str]) -> str:
    if not isinstance(paths, list) or not paths:
        raise ValueError("paths must be a non-empty list.")
    relatives = [relative(resolve_inside(item, ctx.root), ctx.root) for item in paths]
    if "." in relatives:
        raise ValueError("Stage specific paths, not the whole workspace.")
    run_process(["git", "add", "--", *relatives], ctx.root)
    return f"Staged {len(relatives)} path(s): " + ", ".join(relatives)


@tool("git_commit", "Commit the currently staged changes with a message; no auto-staging and no amend.", {"message": STR}, ["message"], risk=VCS)
def git_commit(ctx: Context, message: str) -> str:
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Commit message cannot be empty.")
    return run_process(["git", "commit", "-m", message.strip()], ctx.root, timeout=COMMIT_TIMEOUT_SECONDS)
