"""How strict the server is. Chosen by the user in config.json (mcpServers.vscode.env), never by the model."""

from dataclasses import dataclass, field
from typing import FrozenSet, Mapping

READONLY = "readonly"   # observe only: no writes, no processes, no git changes
STANDARD = "standard"   # default: edits are free; risky actions ask the user first
TRUSTED = "trusted"     # no confirmations (hard rules still apply)
MODES = (READONLY, STANDARD, TRUSTED)

MODE_VARIABLE = "SNAPGENT_POLICY"
EXTRA_COMMANDS_VARIABLE = "SNAPGENT_ALLOWED_COMMANDS"


@dataclass(frozen=True)
class Policy:
    mode: str = STANDARD
    # Executables the user has decided may run WITHOUT asking (bare names, comma separated in the env).
    extra_commands: FrozenSet[str] = field(default_factory=frozenset)

    def __post_init__(self):
        if self.mode not in MODES:
            raise ValueError(f"Unknown policy mode {self.mode!r}; expected one of {', '.join(MODES)}.")

    @property
    def asks(self) -> bool:
        return self.mode == STANDARD


def policy_from_env(env: Mapping[str, str]) -> Policy:
    """An unrecognised mode falls back to STANDARD: a typo must never loosen security."""
    mode = (env.get(MODE_VARIABLE) or STANDARD).strip().lower()
    extra = frozenset(
        item.strip().lower() for item in (env.get(EXTRA_COMMANDS_VARIABLE) or "").split(",") if item.strip()
    )
    return Policy(mode if mode in MODES else STANDARD, extra)
