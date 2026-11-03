"""One-time approval tokens.

When an action needs the user's approval the server refuses it and issues a token. The token is
handed only to the extension (never put in text the model reads); the extension asks the user and, if
approved, repeats the call with the token. A token works once, for exactly the same tool and
arguments, for a short time. A model cannot guess one (128 random bits).
"""

import json
import secrets
import threading
import time
from typing import Any, Callable, Dict, Tuple

RESERVED_ARGUMENT = "__snapgent_confirm"
TOKEN_LIFETIME_SECONDS = 120


def fingerprint(tool: str, arguments: Dict[str, Any]) -> str:
    """The call, minus the token itself, in a canonical form."""
    clean = {key: value for key, value in arguments.items() if key != RESERVED_ARGUMENT}
    return tool + "\n" + json.dumps(clean, sort_keys=True, ensure_ascii=False, default=str)


class ConfirmationStore:
    def __init__(self, clock: Callable[[], float] = time.monotonic,
                 token_factory: Callable[[], str] = lambda: secrets.token_hex(16)) -> None:
        self._clock = clock
        self._make_token = token_factory
        self._pending: Dict[str, Tuple[str, float]] = {}
        self._lock = threading.Lock()  # calls are answered on several threads

    def issue(self, tool: str, arguments: Dict[str, Any]) -> str:
        with self._lock:
            self._expire()
            token = self._make_token()
            self._pending[token] = (fingerprint(tool, arguments), self._clock() + TOKEN_LIFETIME_SECONDS)
            return token

    def redeem(self, token: Any, tool: str, arguments: Dict[str, Any]) -> bool:
        """True exactly once per token, for the call it was issued for."""
        with self._lock:
            self._expire()
            entry = self._pending.pop(token, None) if isinstance(token, str) else None
        return entry is not None and entry[0] == fingerprint(tool, arguments)

    def _expire(self) -> None:
        now = self._clock()
        for token in [t for t, (_, deadline) in self._pending.items() if deadline <= now]:
            del self._pending[token]
