"""The MCP server: reads JSON-RPC requests from stdin, answers on stdout."""

import json
import os
import sys
from typing import Any, Callable, Dict, Optional, TextIO

from . import SERVER_NAME, SERVER_VERSION, protocol
from .context import Context
from .security import CONFIRM, DENY, MODE_ARGUMENT, RESERVED_ARGUMENT, ConfirmationStore, Policy, SessionState, decide, policy_for_call, policy_from_env
from .tools import registry
from .workspace import Workspace

Handler = Callable[[Context, str, Dict[str, Any]], Any]


class McpServer:
    def __init__(self, workspace: Workspace, policy: Optional[Policy] = None, call: Handler = registry.call,
                 schemas=registry.schemas, confirmations: Optional[ConfirmationStore] = None) -> None:
        self._workspace = workspace
        self._policy = policy or Policy()
        self._call = call
        self._schemas = schemas
        self._confirmations = confirmations or ConfirmationStore()
        self._session = SessionState()

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
        # Not tools (the model never sees them): the bar asks which folders exist and pins one.
        if method == "snapgent/workspaces":
            return self._workspace_reply(request_id, lambda: self._workspace.listing())
        if method == "snapgent/set_workspace":
            return self._workspace_reply(request_id, lambda: {"pinned": self._pin(params.get("path"))})
        return protocol.error(request_id, protocol.METHOD_NOT_FOUND, f"Method not found: {method}")

    def _pin(self, path: Any) -> Optional[str]:
        folder = self._workspace.pin(path)
        return str(folder) if folder else None

    @staticmethod
    def _workspace_reply(request_id: Any, make: Callable[[], Any]) -> Dict[str, Any]:
        try:
            return protocol.result(request_id, make())
        except Exception as error:  # a bad path is an answer for the user, not a crash
            return protocol.error(request_id, protocol.INTERNAL_ERROR, str(error))

    def _tools_call(self, request_id: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        name = params.get("name", "")
        arguments = dict(params.get("arguments") or {})
        # The bar's choice (plan / manual / auto) rides along in a reserved argument; it never reaches a tool or a fingerprint.
        policy = policy_for_call(self._policy, arguments.pop(MODE_ARGUMENT, None))
        try:
            ctx = Context(root=self._workspace.root(), policy=policy, session=self._session)
            definition = registry.get(name)
            decision = decide(policy, name, definition.risk, arguments, self._session)
            if decision.verdict == DENY:
                return protocol.error(request_id, protocol.INTERNAL_ERROR, decision.reason)
            if decision.verdict == CONFIRM and not self._confirmations.redeem(arguments.get(RESERVED_ARGUMENT), name, arguments):
                token = self._confirmations.issue(name, arguments)
                return protocol.result(request_id, protocol.confirmation_required(decision.reason, token, name, definition.risk))
            output = self._call(ctx, name, arguments)
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
    McpServer(Workspace(), policy_from_env(os.environ)).serve(sys.stdin, sys.stdout)
