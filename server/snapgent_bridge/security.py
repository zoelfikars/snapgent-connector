"""Who may talk to the bridge.

A web page can open ws://127.0.0.1 too, but browsers always attach the page's real
Origin and scripts cannot forge it, so rejecting everything that is not an extension
origin keeps arbitrary websites out.
"""

import re
from typing import Any, Iterable, Optional

EXTENSION_ORIGIN_RE = re.compile(r"(chrome|moz|ms-browser)-extension://[A-Za-z0-9._-]+")


def origin_allowed(origin: Optional[str], pinned: Optional[Iterable[str]] = None) -> bool:
    """Only browser extensions may drive the bridge; `pinned` narrows that to exact origins."""
    if not origin:
        return False
    pinned = list(pinned or [])
    if pinned:
        return origin in pinned
    return EXTENSION_ORIGIN_RE.fullmatch(origin) is not None


def request_origin(websocket: Any) -> Optional[str]:
    """The Origin header of a connection, across `websockets` library generations."""
    request = getattr(websocket, "request", None)
    headers = getattr(request, "headers", None) or getattr(websocket, "request_headers", None)
    return headers.get("Origin") if headers is not None else None
