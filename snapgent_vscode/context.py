"""What a tool needs to run: the workspace root. (Stage B adds the security policy here.)"""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Context:
    root: Path
