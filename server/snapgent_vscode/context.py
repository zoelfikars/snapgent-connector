"""What a tool needs to run: the workspace root, the active policy and what happened this session."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .security import Policy, SessionState

# on_chunk(stream, text): "stdout" or "stderr" and the lines as they arrive (see process.run_process_streaming).
StreamCallback = Callable[[str, str], None]


@dataclass(frozen=True)
class Context:
    root: Path
    policy: Policy = field(default_factory=Policy)
    session: SessionState = field(default_factory=SessionState)
    # Where live output goes; None for calls nobody is watching (most of them).
    stream: Optional[StreamCallback] = None
