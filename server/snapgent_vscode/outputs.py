"""Command output kept after it was shortened, so the model can ask for more without running the command again."""

from collections import OrderedDict
from threading import Lock
from typing import Dict, Optional

from .limits import OUTPUT_CACHE_MAX_CHARS, OUTPUT_CACHE_MAX_RUNS


class OutputCache:
    """The most recent runs, least recently used first out. Bounded by run count and by total size."""

    def __init__(self, max_runs: int = OUTPUT_CACHE_MAX_RUNS, max_chars: int = OUTPUT_CACHE_MAX_CHARS) -> None:
        self._runs: "OrderedDict[str, Dict[str, object]]" = OrderedDict()
        self._max_runs = max_runs
        self._max_chars = max_chars
        self._size = 0
        self._counter = 0
        self._lock = Lock()

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
