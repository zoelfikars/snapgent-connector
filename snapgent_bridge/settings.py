"""Paths, ports and limits. The only module that reads the environment."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
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
