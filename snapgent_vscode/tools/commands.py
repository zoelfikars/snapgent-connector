"""Tools that run processes."""

import json
import os
import sys
from pathlib import Path
from typing import List, Optional

from ..context import Context
from ..limits import COMMAND_TIMEOUT_SECONDS, SAFE_PROJECT_SCRIPTS, SCRIPT_TIMEOUT_SECONDS
from ..process import run_process
from .registry import EXECUTE, tool
from .schema import STR, STR_LIST

LOCKFILE_MANAGERS = (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"), ("bun.lockb", "bun"))


def package_manager(root: Path) -> str:
    """npm unless a lockfile says otherwise."""
    for lockfile, manager in LOCKFILE_MANAGERS:
        if (root / lockfile).exists():
            return manager
    return "npm"


def shell_wrap(command: List[str]) -> List[str]:
    """On Windows, npm/pnpm/... are .cmd shims that need cmd.exe."""
    return ["cmd.exe", "/c", *command] if os.name == "nt" else command


@tool("run_command", "Run a command with the workspace as its working directory.",
      {"command": STR, "args": STR_LIST}, ["command"], risk=EXECUTE)
def run_command(ctx: Context, command: str, args: Optional[List[str]] = None) -> str:
    if not command.strip():
        raise ValueError("Command cannot be empty.")
    return run_process(shell_wrap([command, *(args or [])]), ctx.root, timeout=COMMAND_TIMEOUT_SECONDS)


def script_command(script: str, root: Path) -> List[str]:
    if script not in SAFE_PROJECT_SCRIPTS:
        raise ValueError(f"Script must be one of: {', '.join(sorted(SAFE_PROJECT_SCRIPTS))}.")
    package_path = root / "package.json"
    if not package_path.is_file():
        raise FileNotFoundError("No package.json found in the workspace root.")
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read package.json: {error}") from error
    if script not in (package.get("scripts") or {}):
        raise ValueError(f"package.json does not define the '{script}' script.")
    return shell_wrap([package_manager(root), "run", script])


@tool("run_project_script", "Run a named safe script (build, check, format, lint, test, typecheck) from package.json.",
      {"script": STR}, ["script"], risk=EXECUTE)
def run_project_script(ctx: Context, script: str) -> str:
    return run_process(script_command(script, ctx.root), ctx.root, timeout=SCRIPT_TIMEOUT_SECONDS)


@tool("run_tests", "Run the workspace test script, pytest, or .NET tests when configured.", risk=EXECUTE)
def run_tests(ctx: Context) -> str:
    root = ctx.root
    if (root / "package.json").is_file():
        return run_project_script(ctx, "test")
    if (root / "pyproject.toml").is_file() or (root / "pytest.ini").is_file():
        return run_process([sys.executable, "-m", "pytest"], root, timeout=SCRIPT_TIMEOUT_SECONDS)
    if any(root.glob("*.sln")) or any(root.glob("*.csproj")):
        return run_process(["dotnet", "test"], root, timeout=SCRIPT_TIMEOUT_SECONDS)
    raise FileNotFoundError("No supported test setup found (package.json, pytest, or .NET project).")
