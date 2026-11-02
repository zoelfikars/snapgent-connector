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
    # The websockets library logs every connect/disconnect at INFO level, which floods
    # the log while an extension is waiting for terminal approval. Keep our own messages.
    for name in ("websockets", "websockets.server", "websockets.client", "websockets.protocol"):
        logging.getLogger(name).setLevel(logging.WARNING)


def log(message: str) -> None:
    logging.info(message)


def notice(message: str) -> None:
    """Log it and show it in the terminal."""
    logging.info(message)
    print(message, flush=True)
