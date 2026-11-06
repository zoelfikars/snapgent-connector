"""Command output kept after it was shortened, so the model can ask for more without running the command again."""

from collections import OrderedDict
from threading import Lock
from typing import Dict, Optional

from .limits import OUTPUT_CACHE_MAX_CHARS, OUTPUT_CACHE_MAX_RUNS


class OutputCache:
    """The most recent runs, least recently used first out. Bounded by run count and by total size.

    A finished command is kept whole with `store`. A command that reports its output while it runs
    reserves an id up front with `begin`, grows it with `append`, and settles it with `set_output`
    plus `finish`, so a reader (the terminal panel, `get_command_output`) can follow along.
    """

    def __init__(self, max_runs: int = OUTPUT_CACHE_MAX_RUNS, max_chars: int = OUTPUT_CACHE_MAX_CHARS) -> None:
        self._runs: "OrderedDict[str, Dict[str, object]]" = OrderedDict()
        self._max_runs = max_runs
        self._max_chars = max_chars
        self._size = 0
        self._counter = 0
        self._lock = Lock()

    def _evict_locked(self) -> None:
        """Drop the oldest runs while over either bound. The run just written is the newest, so it goes last."""
        while self._runs and (len(self._runs) > self._max_runs or self._size > self._max_chars):
            _, evicted = self._runs.popitem(last=False)
            self._size -= len(str(evicted["output"]))

    def begin(self, command: str) -> str:
        """Reserve a run id up front so output can be appended while the command is still running."""
        with self._lock:
            self._counter += 1
            run_id = f"r{self._counter}"
            self._runs[run_id] = {"command": command, "exit_code": None, "output": ""}
            self._evict_locked()
            return run_id

    def append(self, run_id: str, text: str) -> None:
        """Add output to a running command; dropped silently when the run was evicted."""
        if not text:
            return
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            run["output"] = str(run["output"]) + text
            self._runs.move_to_end(run_id)
            self._size += len(text)
            self._evict_locked()

    def set_output(self, run_id: str, output: str) -> None:
        """Replace a run's output (the live interleaving with the final merged streams); unknown ids are ignored."""
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            self._size += len(output) - len(str(run["output"]))
            run["output"] = output
            self._runs.move_to_end(run_id)
            self._evict_locked()

    def finish(self, run_id: str, exit_code: Optional[int]) -> None:
        """Mark a run done (its exit code is now known); unknown ids are ignored."""
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                run["exit_code"] = exit_code
                self._runs.move_to_end(run_id)

    def store(self, command: str, exit_code: int, output: str) -> str:
        """Keep one run's full output; returns its run id."""
        with self._lock:
            self._counter += 1
            run_id = f"r{self._counter}"
            self._runs[run_id] = {"command": command, "exit_code": exit_code, "output": output}
            self._size += len(output)
            while self._runs and (len(self._runs) > self._max_runs or self._size > self._max_chars):
                _, evicted = self._runs.popitem(last=False)
                self._size -= len(str(evicted["output"]))
            return run_id

    def get(self, run_id: str) -> Optional[Dict[str, object]]:
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                self._runs.move_to_end(run_id)
            return run

    def clear(self) -> None:
        with self._lock:
            self._runs.clear()
            self._size = 0


CACHE = OutputCache()
