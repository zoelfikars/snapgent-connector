"""How strict the server is. Chosen by the user in config.json (mcpServers.snapgent.env), never by the model."""

from dataclasses import dataclass, field
from typing import FrozenSet, Mapping

READONLY = "readonly"   # observe only: no writes, no processes, no git changes
STANDARD = "standard"   # default: edits are free; risky actions ask the user first
TRUSTED = "trusted"     # no confirmations (hard rules still apply)
MODES = (READONLY, STANDARD, TRUSTED)

# What the extension's bar offers, and the mode each choice means. The extension sends its choice with every call in a reserved
# argument the model cannot set (it is stripped from model arguments there, and ignored here unless it is one of these).
MODE_ARGUMENT = "__snapgent_mode"
BAR_CHOICES = {"plan": READONLY, "manual": STANDARD, "auto": TRUSTED}
_STRICTNESS = {READONLY: 0, STANDARD: 1, TRUSTED: 2}

MODE_VARIABLE = "SNAPGENT_POLICY"
EXTRA_COMMANDS_VARIABLE = "SNAPGENT_ALLOWED_COMMANDS"


@dataclass(frozen=True)
class Policy:
    mode: str = STANDARD
    # Executables the user has decided may run WITHOUT asking (bare names, comma separated in the env).
    extra_commands: FrozenSet[str] = field(default_factory=frozenset)
    # The user set a mode in config.json: the bar may make the server stricter than that, never looser.
    locked: bool = False

    def __post_init__(self):
        if self.mode not in MODES:
            raise ValueError(f"Unknown policy mode {self.mode!r}; expected one of {', '.join(MODES)}.")

    @property
    def asks(self) -> bool:
        return self.mode == STANDARD


def policy_for_call(policy: Policy, choice: object) -> Policy:
    """The policy for one call, given the bar's choice (`plan`, `manual`, `auto`). Anything else keeps the server's own policy."""
    wanted = BAR_CHOICES.get(choice) if isinstance(choice, str) else None
    if wanted is None:
        return policy
    if policy.locked and _STRICTNESS[wanted] > _STRICTNESS[policy.mode]:
        return policy
    return Policy(wanted, policy.extra_commands, policy.locked)


def policy_from_env(env: Mapping[str, str]) -> Policy:
    """An unrecognised mode falls back to STANDARD: a typo must never loosen security."""
    chosen = (env.get(MODE_VARIABLE) or "").strip().lower()
    mode = chosen or STANDARD
    extra = frozenset(
        item.strip().lower() for item in (env.get(EXTRA_COMMANDS_VARIABLE) or "").split(",") if item.strip()
    )
    return Policy(mode if mode in MODES else STANDARD, extra, locked=bool(chosen))
