"""Running child processes with bounded output and time."""

import subprocess
from pathlib import Path
from typing import List, Optional

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


def run_process(command: List[str], cwd: Path, timeout: int = COMMAND_TIMEOUT_SECONDS,
                max_output_chars: Optional[int] = None) -> str:
    """Run without a shell. Returns trimmed output; a non-zero exit becomes a RuntimeError with that output."""
    try:
        result = subprocess.run(
            command, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace",
            shell=False, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"The command was stopped after {timeout} seconds without finishing. It may still be needed: "
            "run long jobs detached or in smaller steps (for example start a build in the background and check on it)."
        ) from error
    stdout, stderr = result.stdout.strip(), result.stderr.strip()
    # Both streams: a failing build prints its reason on stderr even when stdout is not empty.
    output = f"{stdout}\n[stderr]\n{stderr}" if stdout and stderr else (stdout or stderr or "(no output)")
    limit = clamp_chars(max_output_chars)
    if len(output) > limit:
        output = compact(output, limit, CACHE.store(" ".join(command), result.returncode, output))
    if result.returncode:
        raise RuntimeError(f"Command exited with status {result.returncode}:\n{output}")
    return output
