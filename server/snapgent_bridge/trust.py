"""Which browser extensions the user has approved to control the bridge.

The scheme check (security.py) keeps WEBSITES out, but every installed extension passes it, and an
extension that is not snapgent could ask the bridge to run tools, add servers and even approve its own
confirmation tokens. So an extension must be approved once by the person at the keyboard, the way SSH
asks about a new host. The bridge runs in a terminal window the user is looking at, so it asks there.

Rejecting the first attempt immediately (instead of holding the socket open) keeps this simple: the
extension reconnects every few seconds and succeeds as soon as the answer is "yes".
"""

import asyncio
import json
import sys
import threading
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Optional, Set

Ask = Callable[[str], Awaitable[bool]]

# Two unknown extensions can connect at the same time. Their prompts are read from the same terminal,
# so they must take turns: otherwise two threads read one answer and one question is silently swallowed.
_ASK_LOCK = threading.Lock()


class TrustStore:
    """Approved origins, remembered across runs in a small JSON file next to config.json."""

    def __init__(self, path: Optional[Path]) -> None:
        self._path = path
        self._origins: Set[str] = set()
        self._load()

    def _load(self) -> None:
        if self._path is None or not self._path.is_file():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._origins = {item for item in data.get("origins", []) if isinstance(item, str)}
        except (OSError, ValueError, AttributeError):
            self._origins = set()  # an unreadable file means nobody is trusted yet, never "everybody"

    def __contains__(self, origin: str) -> bool:
        return origin in self._origins

    def add(self, origin: str) -> None:
        self._origins.add(origin)
        if self._path is not None:
            temp = self._path.with_suffix(".json.tmp")
            temp.write_text(json.dumps({"origins": sorted(self._origins)}, indent=2) + "\n", encoding="utf-8")
            temp.replace(self._path)


def _read_answer(prompt: str) -> str:
    """Blocking part of the question: only one prompt may own the terminal at a time."""
    with _ASK_LOCK:
        try:
            return input(prompt)
        except (EOFError, OSError):
            return ""  # terminal closed or no input: treat it as a refusal


async def ask_in_terminal(origin: str) -> bool:
    """Ask the person running the bridge. Without a terminal there is nobody to ask: the answer is no."""
    if not sys.stdin or not sys.stdin.isatty():
        return False
    prompt = (
        "\n"
        "  ----------------------------------------------------------------\n"
        "  A browser extension wants to control this bridge:\n"
        "\n"
        f"      {origin}\n"
        "\n"
        "  Approve it ONLY if it is your own snapgentV3 extension (it will stay approved).\n"
        "  Type y and press Enter to allow it, or anything else to refuse.\n"
        "\n"
        "  Allow? [y/N] "
    )
    answer = await asyncio.get_running_loop().run_in_executor(None, _read_answer, prompt)
    return answer.strip().lower() in ("y", "yes")


class TrustPolicy:
    def __init__(self, store: TrustStore, pinned: Iterable[str], ask: Ask, log: Callable[[str], None]) -> None:
        self._store = store
        self._pinned = set(pinned)
        self._ask = ask
        self._log = log
        self._asking: Set[str] = set()
        self._refused: Set[str] = set()  # asked this run and told no: do not nag again until restart

    def allows(self, origin: str) -> bool:
        """True if this origin may connect NOW. An unknown one starts a question in the background and
        is turned away for the moment; it gets in on a later attempt if the user says yes."""
        if self._pinned:
            return origin in self._pinned  # the user fixed the exact origin: no questions
        if origin in self._store:
            return True
        if origin not in self._asking and origin not in self._refused:
            self._asking.add(origin)
            asyncio.get_running_loop().create_task(self._resolve(origin))
        return False

    async def _resolve(self, origin: str) -> None:
        try:
            approved = await self._ask(origin)
        except Exception as error:  # a failed prompt must never become approval
            self._log(f"could not ask about {origin!r}: {error}")
            approved = False
        finally:
            self._asking.discard(origin)
        if approved:
            self._store.add(origin)
            self._log(f"approved extension {origin!r}")
        else:
            self._refused.add(origin)
            self._log(
                f"refused extension {origin!r}. If it is yours, restart the bridge and answer y, "
                "or set ZS_ALLOWED_ORIGINS to its exact origin."
            )
