"""Turns one request from the extension into replies. No sockets: it talks through `reply` and `broadcast`."""

import asyncio
import os
import time
from typing import Any, Awaitable, Callable, Dict

from . import folder_picker, protocol
from .config import PROTECTED_SERVER_ID, ConfigStore
from .registry import ServerRegistry
from .settings import MAX_LOG_CHARS

Reply = Callable[[Dict[str, Any]], Awaitable[None]]


class RequestRouter:
    def __init__(self, registry: ServerRegistry, config: ConfigStore, broadcast: Reply, version: str,
                 log: Callable[[str], None]) -> None:
        self._registry = registry
        self._config = config
        self._broadcast = broadcast
        self._version = version
        self._log = log
        self._handlers = {
            "ping": self._ping,
            "list_tools": self._list_tools,
            "call_tool": self._call_tool,
            "restart_mcp": self._restart_mcp,
            "add_server": self._add_server,
            "remove_server": self._remove_server,
            "workspaces": self._workspaces,
            "set_workspace": self._set_workspace,
            "pick_folder": self._pick_folder,
        }

    def connected_message(self) -> Dict[str, Any]:
        return protocol.connected_message(
            self._version, self._registry.any_alive, self._registry.catalog, self._registry.status()
        )

    async def handle(self, request: Dict[str, Any], reply: Reply) -> None:
        kind = request.get("type")
        handler = self._handlers.get(kind)
        if handler is None:
            await reply(protocol.error_message(request.get("id"), f"Unknown bridge request: {kind}"))
            return
        await handler(request, reply)

    # ── handlers ───────────────────────────────────────────────────────────

    async def _ping(self, request, reply):
        await reply({"type": "pong", "id": request.get("id")})

    async def _list_tools(self, request, reply):
        await reply(protocol.tools_message(self.connected_message(), request.get("id")))

    async def _restart_mcp(self, request, reply):
        request_id = request.get("id")
        try:
            await self._registry.restart(self._config.load_servers())
            message = protocol.mcp_status_message(
                request_id, True, self._registry.any_alive, self._registry.catalog, self._registry.status()
            )
        except (OSError, RuntimeError) as error:
            message = protocol.mcp_status_message(request_id, False, False, error=str(error))
        await reply(message)
        await self._broadcast(self.connected_message())

    async def _add_server(self, request, reply):
        await self._change_servers(
            request, reply,
            lambda: self._config.add_server(request.get("server_id"), request.get("command"), request.get("args", []), request.get("env", {})),
        )

    async def _remove_server(self, request, reply):
        await self._change_servers(request, reply, lambda: self._config.remove_server(request.get("server_id")))

    async def _change_servers(self, request, reply, mutate) -> None:
        request_id = request.get("id")
        try:
            mutate()
            await self._registry.restart(self._config.load_servers())
        except (OSError, RuntimeError) as error:  # ConfigError is a RuntimeError
            await reply(protocol.server_changed_message(request_id, False, str(error)))
            return
        await reply(protocol.server_changed_message(request_id, True))
        await self._broadcast(self.connected_message())

    async def _workspaces(self, request, reply):
        await self._ask_vscode("snapgent/workspaces", {}, request, reply, self._with_recent)

    async def _set_workspace(self, request, reply):
        await self._ask_vscode("snapgent/set_workspace", {"path": request.get("path")}, request, reply, self._remember)

    def _with_recent(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """The folders used lately that still exist: what a chat can start in when no editor has a folder open."""
        return {**data, "recent": [path for path in self._config.recent_folders() if os.path.isdir(path)]}

    def _remember(self, data: Dict[str, Any]) -> Dict[str, Any]:
        if data.get("pinned"):
            try:
                self._config.remember_folder(data["pinned"])
            except (OSError, RuntimeError) as error:  # a recent list that cannot be saved must not fail the choice
                self._log(f"recent folders not saved: {error}")
        return data

    async def _pick_folder(self, request, reply):
        """Open the system's folder window on this machine; the answer is the chosen path (or none when it was closed)."""
        try:
            chosen = await folder_picker.pick_folder()
        except folder_picker.PickerUnavailable as error:
            await reply(protocol.workspace_message(request.get("id"), False, error=str(error)))
            return
        await reply(protocol.workspace_message(request.get("id"), True, {"picked": chosen}))

    async def _ask_vscode(self, method, params, request, reply, finish=lambda data: data):
        """The bar's questions about the default server's workspace (which folders, which one is pinned)."""
        server = self._registry.servers.get(PROTECTED_SERVER_ID)
        if server is None:
            await reply(protocol.workspace_message(request.get("id"), False, error="The Snapgent MCP server is not configured."))
            return
        try:
            data = await server.request(method, params)
        except (asyncio.TimeoutError, RuntimeError, OSError) as error:
            await reply(protocol.workspace_message(request.get("id"), False, error=str(error) or "The Snapgent MCP server did not answer."))
            return
        await reply(protocol.workspace_message(request.get("id"), True, finish(data if isinstance(data, dict) else {})))

    async def _call_tool(self, request, reply):
        call = protocol.parse_tool_call(request)
        if call is None:
            await reply(protocol.tool_error(request.get("id"), "Invalid tool call."))
            return
        target = self._registry.resolve_for_call(call.name, call.selected_server)
        if target.error:
            await reply(protocol.tool_error(call.request_id, target.error, target.kind))
            return
        started = time.monotonic()
        try:
            result = await target.server.call_tool(target.tool_name, call.arguments, call.timeout_seconds)
        except (asyncio.TimeoutError, RuntimeError, OSError, ValueError) as error:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            kind = "timeout" if isinstance(error, asyncio.TimeoutError) else "tool_error"
            await reply(protocol.tool_error(call.request_id, str(error), kind))
            self._log(f"<- {call.name} ERROR: {str(error)[:MAX_LOG_CHARS]} ({elapsed_ms} ms)")
            return
        elapsed_ms = int((time.monotonic() - started) * 1000)
        # Only slow calls are logged, so timing data is available without spamming.
        if elapsed_ms >= 250:
            self._log(f"<- {call.name} took {elapsed_ms} ms")
        message, text = protocol.tool_result_message(call.request_id, result)
        await reply(message)
        # Keep the result out of the log: previews of every call (especially large
        # list_dir/read_file results) were the main source of log spam. Failures
        # are still logged above.
