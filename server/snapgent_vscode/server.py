"""The MCP server: reads JSON-RPC requests from stdin, answers on stdout."""

import json
import os
import sys
import threading
from typing import Any, Callable, Dict, Optional, TextIO

from . import SERVER_NAME, SERVER_VERSION, protocol
from .context import Context
from .jobs import JOB_ARGUMENT, JOB_OP_ARGUMENT, JobStore
from .security import CONFIRM, DENY, MODE_ARGUMENT, RESERVED_ARGUMENT, ConfirmationStore, Policy, SessionState, decide, policy_for_call, policy_from_env
from .tools import registry
from .tools.registry import READ
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
        self._jobs = JobStore()

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
        # Likewise the extension's name for this call: set by the extension only, never part of what a tool or a fingerprint sees.
        job_key = arguments.pop(JOB_ARGUMENT, None)
        job_key = job_key if isinstance(job_key, str) and job_key else None
        job_op = arguments.pop(JOB_OP_ARGUMENT, None)
        try:
            if job_key and job_op == "cancel":
                return protocol.result(request_id, protocol.tool_output(self._jobs.cancel(job_key)))
            existing = self._jobs.get(job_key) if job_key else None
            if existing is not None:
                # The same call again (the page was reloaded): answer from the job, never run it twice or ask the user again.
                return protocol.result(request_id, protocol.tool_output(existing.wait()))
            ctx = Context(root=self._workspace.root(), policy=policy, session=self._session)
            definition = registry.get(name)
            decision = decide(policy, name, definition.risk, arguments, self._session)
            if decision.verdict == DENY:
                return protocol.error(request_id, protocol.INTERNAL_ERROR, decision.reason)
            if decision.verdict == CONFIRM and not self._confirmations.redeem(arguments.get(RESERVED_ARGUMENT), name, arguments):
                token = self._confirmations.issue(name, arguments)
                return protocol.result(request_id, protocol.confirmation_required(decision.reason, token, name, definition.risk))
            if job_key and definition.risk != READ:
                output = self._jobs.start(job_key, name, lambda: self._call(ctx, name, arguments)).wait()
            else:
                output = self._call(ctx, name, arguments)
            return protocol.result(request_id, protocol.tool_output(output))
        except Exception as error:  # every failure becomes a reply the model can read
            return protocol.error(request_id, protocol.INTERNAL_ERROR, str(error))

    def serve(self, stdin: TextIO, stdout: TextIO) -> None:
        """Answer requests as they come. A tool call may take minutes, so each one gets its own thread: the page can ask
        about (or cancel) a job while it runs. Everything else is quick and answered in order."""
        write_lock = threading.Lock()
        workers = []

        def answer(request: Dict[str, Any]) -> None:
            reply = self.handle(request)
            if reply is not None:
                with write_lock:
                    stdout.write(protocol.encode(reply) + "\n")
                    stdout.flush()

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
            if request.get("method") == "tools/call":
                worker = threading.Thread(target=answer, args=(request,), daemon=True)
                worker.start()
                workers.append(worker)
                workers[:] = [w for w in workers if w.is_alive()]
            else:
                answer(request)
        for worker in workers:  # input closed: let the calls in flight finish writing their answers
            worker.join(timeout=5)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    McpServer(Workspace(), policy_from_env(os.environ)).serve(sys.stdin, sys.stdout)
