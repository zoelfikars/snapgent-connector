"""Running child processes with bounded output and time."""

import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from .jobs import CANCELLED_MESSAGE, current_job, stop_process
from .limits import COMMAND_OUTPUT_CHARS, COMMAND_TIMEOUT_SECONDS, MAX_OUTPUT_CHARS
from .outputs import CACHE


def clamp_chars(requested: Optional[int], default: int = COMMAND_OUTPUT_CHARS) -> int:
    """The size to keep: what the caller asked for, within sane bounds."""
    if requested is None:
        return default
    return max(1_000, min(int(requested), MAX_OUTPUT_CHARS))


def compact(output: str, limit: int, run_id: str) -> str:
    """Keep the start and the end (errors are usually at the end), say what was left out and how to get it."""
    if len(output) <= limit:
        return output
    head_chars = limit * 2 // 5
    tail_chars = limit - head_chars
    omitted = output[head_chars:len(output) - tail_chars]
    marker = (f"\n... [{len(omitted):,} characters / {omitted.count(chr(10)) + 1:,} lines omitted from the middle; "
              f"full output kept as run_id {run_id}, read it with get_command_output] ...\n")
    return output[:head_chars] + marker + output[len(output) - tail_chars:]


def child_environment() -> dict:
    """The environment a command should see. The one-file Linux program points LD_LIBRARY_PATH at the libraries bundled inside it;
    a child that inherits that (bash, git, cargo) loads them instead of the system's and dies with `symbol lookup error`. PyInstaller
    keeps the user's own value in `<NAME>_ORIG`: put it back."""
    env = dict(os.environ)
    if getattr(sys, "frozen", False):
        for name in ("LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH"):
            original = env.pop(f"{name}_ORIG", None)
            if original is None:
                env.pop(name, None)
            else:
                env[name] = original
    return env


def run_process(command: List[str], cwd: Path, timeout: int = COMMAND_TIMEOUT_SECONDS,
                max_output_chars: Optional[int] = None) -> str:
    """Run without a shell. Returns trimmed output; a non-zero exit becomes a RuntimeError with that output.
    When it runs for a job, the job can stop it (and what it started) at any time."""
    job = current_job()
    group = {"start_new_session": True} if os.name != "nt" else {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    process = subprocess.Popen(
        command, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        errors="replace", shell=False, env=child_environment(), **group,
    )
    if job:
        job.attach(process)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        stop_process(process)
        process.communicate()
        raise RuntimeError(
            f"The command was stopped after {timeout} seconds without finishing. It may still be needed: "
            "run long jobs detached or in smaller steps (for example start a build in the background and check on it)."
        ) from error
    finally:
        if job:
            job.detach(process)
    if job and job.cancelled:
        raise RuntimeError(CANCELLED_MESSAGE)
    stdout, stderr = stdout.strip(), stderr.strip()
    # Both streams: a failing build prints its reason on stderr even when stdout is not empty.
    output = f"{stdout}\n[stderr]\n{stderr}" if stdout and stderr else (stdout or stderr or "(no output)")
    limit = clamp_chars(max_output_chars)
    if len(output) > limit:
        output = compact(output, limit, CACHE.store(" ".join(command), process.returncode, output))
    if process.returncode:
        raise RuntimeError(f"Command exited with status {process.returncode}:\n{output}")
    return output
