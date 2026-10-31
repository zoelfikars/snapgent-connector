"""Paths, ports and limits. The only module that reads the environment."""

import os
import sys
from pathlib import Path


def app_root(frozen: bool = getattr(sys, "frozen", False), executable: str = sys.executable, module_file: str = __file__) -> Path:
    """The folder holding config.json and logs/.

    From source that is the repository (or release) folder. Inside a PyInstaller executable `__file__`
    points into a temporary unpack directory, so the folder next to the .exe is used instead.
    """
    if frozen:
        return Path(executable).resolve().parent
    return Path(module_file).resolve().parent.parent


ROOT = app_root()
CONFIG_PATH = ROOT / "config.json"
LOG_PATH = ROOT / "logs" / "bridge_debug.log"

HOST = "127.0.0.1"
PORT = int(os.environ.get("ZS_BRIDGE_PORT", "17613"))

MCP_PROTOCOL_VERSION = "2024-11-05"
MAX_LOG_CHARS = 1000
# asyncio limits each line read from a subprocess; one large MCP response must not kill the reader.
MCP_STDOUT_LIMIT = 64 * 1024 * 1024
WS_MAX_MESSAGE_BYTES = 50 * 1024 * 1024
MONITOR_INTERVAL_SECONDS = 5

DEFAULT_TOOL_TIMEOUT_MS = 120000
MAX_TOOL_TIMEOUT_SECONDS = 300.0


def pinned_origins() -> list:
    """Exact extension origins allowed to connect (ZS_ALLOWED_ORIGINS, comma separated); empty = any extension."""
    raw = os.environ.get("ZS_ALLOWED_ORIGINS", "")
    return [item.strip() for item in raw.split(",") if item.strip()]
