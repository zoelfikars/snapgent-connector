"""Logging: always printed, and written to a file once `configure` has been called."""

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
    print(message, flush=True)
