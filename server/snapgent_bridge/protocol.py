"""The messages exchanged with the extension. Pure: dicts in, dicts out, no I/O."""

import json
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from .settings import DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_SECONDS


def json_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ── replies ────────────────────────────────────────────────────────────────

def connected_message(version: str, mcp_alive: bool, tools: List[dict], servers: List[dict]) -> Dict[str, Any]:
    return {"type": "connected", "bridge_version": version, "mcp_alive": mcp_alive, "tools": tools, "servers": servers}


def tools_message(connected: Dict[str, Any], request_id: Any) -> Dict[str, Any]:
    return {**connected, "type": "tools", "id": request_id}


def error_message(request_id: Any, error: str) -> Dict[str, Any]:
    message: Dict[str, Any] = {"type": "error", "error": error}
    if request_id is not None:
        message["id"] = request_id
    return message


def tool_error(request_id: Any, error: str, kind: Optional[str] = None) -> Dict[str, Any]:
    message: Dict[str, Any] = {"type": "tool_result", "id": request_id, "ok": False, "error": error}
    if kind:
        message["kind"] = kind
    return message


def mcp_status_message(request_id: Any, ok: bool, alive: bool, tools: Optional[list] = None,
                       servers: Optional[list] = None, error: Optional[str] = None) -> Dict[str, Any]:
    message: Dict[str, Any] = {"type": "mcp_status", "id": request_id, "ok": ok, "alive": alive}
    if ok:
        message.update(tools=tools, servers=servers)
    else:
        message["error"] = error
    return message


def server_changed_message(request_id: Any, ok: bool, error: Optional[str] = None) -> Dict[str, Any]:
    message: Dict[str, Any] = {"type": "server_changed", "id": request_id, "ok": ok}
    if ok:
        message["restarting"] = False
    else:
        message["error"] = error
    return message


# ── tool calls ─────────────────────────────────────────────────────────────

class ToolCall(NamedTuple):
    request_id: Any
    name: str
    arguments: Dict[str, Any]
    timeout_seconds: float
    selected_server: Optional[str]


def clamp_timeout(raw: Any) -> float:
    """Milliseconds from the extension -> seconds, within [1, 300]; garbage means the default."""
    try:
        return max(1.0, min(float(raw) / 1000, MAX_TOOL_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_TOOL_TIMEOUT_MS / 1000


def parse_tool_call(request: Dict[str, Any]) -> Optional[ToolCall]:
    """None when the request is not a well-formed tool call."""
    name = request.get("name")
    arguments = request.get("arguments") or {}
    if not isinstance(name, str) or not isinstance(arguments, dict):
        return None
    selected = request.get("server")
    return ToolCall(
        request_id=request.get("id"),
        name=name,
        arguments=arguments,
        timeout_seconds=clamp_timeout(request.get("timeout", DEFAULT_TOOL_TIMEOUT_MS)),
        selected_server=selected if isinstance(selected, str) and selected else None,
    )


def split_content(result: Dict[str, Any]) -> Tuple[str, List[Dict[str, str]]]:
    """Flatten an MCP tool result into display text plus attached images."""
    texts: List[str] = []
    images: List[Dict[str, str]] = []
    for item in result.get("content", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text" and isinstance(item.get("text"), str):
            texts.append(item["text"])
        elif item.get("type") == "image" and isinstance(item.get("data"), str):
            images.append({"data": item["data"], "mimeType": item.get("mimeType", "image/png")})
    structured = result.get("structuredContent")
    if not texts and structured is not None:
        texts.append(json.dumps(structured, ensure_ascii=False))
    return "\n".join(texts), images


def tool_result_message(request_id: Any, result: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """The reply for a finished tool call, and the text for the log."""
    text, images = split_content(result)
    confirmation = (result.get("structuredContent") or {}).get("confirmation")
    if result.get("isError") and isinstance(confirmation, dict):
        # The server wants the USER's approval. The token travels in this field for the extension only.
        message = tool_error(request_id, text or "Confirmation required.", "confirmation_required")
        message["confirmation"] = confirmation
        return message, text
    if result.get("isError"):
        return tool_error(request_id, text or "MCP tool failed."), text
    return {"type": "tool_result", "id": request_id, "ok": True, "text": text, "images": images}, text
