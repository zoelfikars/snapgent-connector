"""Tools that run processes."""

import json
import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional

from ..context import Context
from ..limits import COMMAND_TIMEOUT_SECONDS, MAX_OUTPUT_CHARS, SAFE_PROJECT_SCRIPTS, SCRIPT_TIMEOUT_SECONDS
from ..outputs import CACHE
from ..process import run_process_streaming
from ..security.commands import unsafe_for_cmd
from .registry import EXECUTE, READ, tool
from .schema import STR, STR_LIST, integer

OUTPUT_CHARS = integer(1_000, MAX_OUTPUT_CHARS)  # how much of the output to keep; the middle is cut beyond it

LOCKFILE_MANAGERS = (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"), ("bun.lockb", "bun"))


def package_manager(root: Path) -> str:
    """npm unless a lockfile says otherwise."""
    for lockfile, manager in LOCKFILE_MANAGERS:
        if (root / lockfile).exists():
            return manager
    return "npm"


def python_interpreter(frozen: bool = getattr(sys, "frozen", False)) -> str:
    """The Python that runs the project's tests. In a packaged .exe `sys.executable` is the .exe itself."""
    if not frozen:
        return sys.executable
    found = shutil.which("python3") or shutil.which("python") or shutil.which("py")
    if not found:
        raise FileNotFoundError("Python was not found on PATH, so pytest cannot be run.")
    return found


def shell_wrap(command: List[str], windows: Optional[bool] = None) -> List[str]:
    """On Windows, npm/pnpm/... are .cmd shims that need cmd.exe, which would run `& other-command`
    smuggled into any argument; refuse such arguments instead of trusting the quoting."""
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        return command
    unsafe = unsafe_for_cmd(command)
    if unsafe:
        raise ValueError(f"Refusing arguments with shell metacharacters on Windows: {unsafe[0][:60]!r}")
    return ["cmd.exe", "/c", *command]


@tool("run_command", "Run a command with the workspace as its working directory.",
      {"command": STR, "args": STR_LIST, "max_output_chars": OUTPUT_CHARS}, ["command"], risk=EXECUTE)
def run_command(ctx: Context, command: str, args: Optional[List[str]] = None, max_output_chars: Optional[int] = None) -> str:
    if not command.strip():
        raise ValueError("Command cannot be empty.")
    return run_process_streaming(shell_wrap([command, *(args or [])]), ctx.root, timeout=COMMAND_TIMEOUT_SECONDS,
                                 max_output_chars=max_output_chars, on_chunk=ctx.stream)


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
      {"script": STR, "max_output_chars": OUTPUT_CHARS}, ["script"], risk=EXECUTE)
def run_project_script(ctx: Context, script: str, max_output_chars: Optional[int] = None) -> str:
    return run_process_streaming(script_command(script, ctx.root), ctx.root, timeout=SCRIPT_TIMEOUT_SECONDS,
                                 max_output_chars=max_output_chars, on_chunk=ctx.stream)


@tool("run_tests", "Run the workspace test script, pytest, or .NET tests when configured.",
      {"max_output_chars": OUTPUT_CHARS}, risk=EXECUTE)
def run_tests(ctx: Context, max_output_chars: Optional[int] = None) -> str:
    root = ctx.root
    if (root / "package.json").is_file():
        return run_project_script(ctx, "test", max_output_chars)
    if (root / "pyproject.toml").is_file() or (root / "pytest.ini").is_file():
        return run_process_streaming([python_interpreter(), "-m", "pytest"], root, timeout=SCRIPT_TIMEOUT_SECONDS,
                                     max_output_chars=max_output_chars, on_chunk=ctx.stream)
    if any(root.glob("*.sln")) or any(root.glob("*.csproj")):
        return run_process_streaming(["dotnet", "test"], root, timeout=SCRIPT_TIMEOUT_SECONDS,
                                     max_output_chars=max_output_chars, on_chunk=ctx.stream)
    raise FileNotFoundError("No supported test setup found (package.json, pytest, or .NET project).")


@tool("get_command_output", "Read more of an earlier command's output that was shortened (its run_id is in the omitted-output note), "
                            "without running the command again. Lines are numbered from 1; use negative start_line to count from the end.",
      {"run_id": STR, "start_line": integer(), "max_lines": integer(1, 5000), "max_chars": OUTPUT_CHARS}, ["run_id"], risk=READ)
def get_command_output(ctx: Context, run_id: str, start_line: int = 1, max_lines: int = 500, max_chars: Optional[int] = None) -> str:
    run = CACHE.get(str(run_id).strip())
    if run is None:
        raise LookupError(f"No saved output for run_id '{run_id}': only the most recent runs are kept. Run the command again if it is still needed.")
    lines = str(run["output"]).splitlines()
    total = len(lines)
    start = max(0, total + int(start_line)) if int(start_line) < 0 else max(0, int(start_line) - 1)
    chosen = lines[start:start + max(1, int(max_lines))]
    body = "\n".join(f"{start + offset + 1}: {line}" for offset, line in enumerate(chosen))
    limit = 40_000 if max_chars is None else max(1_000, min(int(max_chars), MAX_OUTPUT_CHARS))
    if len(body) > limit:
        body = body[:limit] + "\n[cut here: ask for a smaller max_lines or a later start_line]"
    header = f"run_id {run_id}: `{run['command']}` exited {run['exit_code']}; lines {start + 1}-{start + len(chosen)} of {total}"
    return f"{header}\n{body}"
