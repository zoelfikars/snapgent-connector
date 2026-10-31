"""Running child processes with bounded output and time."""

import subprocess
from pathlib import Path
from typing import List

from .limits import COMMAND_TIMEOUT_SECONDS, MAX_FILE_CHARS


def run_process(command: List[str], cwd: Path, timeout: int = COMMAND_TIMEOUT_SECONDS) -> str:
    """Run without a shell. Returns trimmed output; a non-zero exit becomes a RuntimeError with that output."""
    result = subprocess.run(
        command, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace",
        shell=False, timeout=timeout, check=False,
    )
    output = result.stdout.strip() or result.stderr.strip() or "(no output)"
    if result.returncode:
        raise RuntimeError(f"Command exited with status {result.returncode}:\n{output[:MAX_FILE_CHARS]}")
    return output[:MAX_FILE_CHARS]
