"""What a tool needs to run: the workspace root, the active policy and what happened this session."""

from dataclasses import dataclass, field
from pathlib import Path

from .security import Policy, SessionState


@dataclass(frozen=True)
class Context:
    root: Path
    policy: Policy = field(default_factory=Policy)
    session: SessionState = field(default_factory=SessionState)
