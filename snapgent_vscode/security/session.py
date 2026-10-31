"""What the agent has done in this server session that changes how risky later actions are."""

from typing import List

from .files import is_execution_config


class SessionState:
    def __init__(self) -> None:
        self.changed_execution_configs: List[str] = []

    def note_write(self, relative_path: str) -> None:
        """Remember that the agent wrote a file that decides what project scripts will execute."""
        if is_execution_config(relative_path) and relative_path not in self.changed_execution_configs:
            self.changed_execution_configs.append(relative_path)
