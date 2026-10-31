"""JSON-RPC messages of the MCP stdio protocol. Pure: dicts in, dicts out."""

import json
from typing import Any, Dict

PROTOCOL_VERSION = "2024-11-05"
INTERNAL_ERROR = -32603
METHOD_NOT_FOUND = -32601


def result(request_id: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def initialize_result(server_name: str, server_version: str) -> Dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": server_name, "version": server_version},
    }


def tool_output(output: Any) -> Dict[str, Any]:
    """A successful tool call: text for the model, the raw value for programs."""
    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}], "structuredContent": {"result": output}}


def confirmation_required(description: str, token: str, tool: str, risk: str) -> Dict[str, Any]:
    """An action that needs the user's approval. The token travels in structured data for the extension
    only: the text is what the model reads, and it must not contain anything that could approve the action."""
    return {
        "isError": True,
        "content": [{"type": "text", "text": f"CONFIRMATION_REQUIRED: {description}. It was NOT run; the user has to approve it."}],
        "structuredContent": {"confirmation": {"token": token, "description": description, "tool": tool, "risk": risk}},
    }


def encode(message: Dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False)
