"""Logging: everything goes to the log file once `configure` has been called; only `notice` also reaches the terminal,
so the window stays readable (the approval question, where to listen, a fatal error)."""

import logging
from pathlib import Path


def configure(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(path),
        level=logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def log(message: str) -> None:
    logging.info(message)


def notice(message: str) -> None:
    """Log it and show it in the terminal."""
    logging.info(message)
    print(message, flush=True)
