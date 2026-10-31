"""The MCP server: reads JSON-RPC requests from stdin, answers on stdout."""

import json
import sys
from typing import Any, Callable, Dict, Optional, TextIO

from . import SERVER_NAME, SERVER_VERSION, protocol
from .context import Context
from .tools import registry
from .workspace import Workspace

Handler = Callable[[Context, str, Dict[str, Any]], Any]


class McpServer:
    def __init__(self, workspace: Workspace, call: Handler = registry.call, schemas=registry.schemas) -> None:
        self._workspace = workspace
        self._call = call
        self._schemas = schemas

    def handle(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The reply to one request, or None when none is due (notifications)."""
        method = request.get("method")
        request_id = request.get("id")
        params = request.get("params") or {}
        if method == "initialize":
            return protocol.result(request_id, protocol.initialize_result(SERVER_NAME, SERVER_VERSION))
        if method == "ping":
            return protocol.result(request_id, {})
        if method == "tools/list":
            # No workspace, no tools: the extension then reports the target as unavailable.
            return protocol.result(request_id, {"tools": self._schemas() if self._workspace.is_open() else []})
        if method == "tools/call":
            return self._tools_call(request_id, params)
        if method == "notifications/initialized":
            return None
        return protocol.error(request_id, protocol.METHOD_NOT_FOUND, f"Method not found: {method}")

    def _tools_call(self, request_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        try:
            ctx = Context(root=self._workspace.root())
            output = self._call(ctx, params.get("name", ""), params.get("arguments") or {})
            return protocol.result(request_id, protocol.tool_output(output))
        except Exception as error:  # every failure becomes a reply the model can read
            return protocol.error(request_id, protocol.INTERNAL_ERROR, str(error))

    def serve(self, stdin: TextIO, stdout: TextIO) -> None:
        for line in stdin:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                request = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(request, dict):
                continue
            reply = self.handle(request)
            if reply is not None:
                stdout.write(protocol.encode(reply) + "\n")
                stdout.flush()


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    McpServer(Workspace()).serve(sys.stdin, sys.stdout)
