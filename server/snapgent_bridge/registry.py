"""The set of running MCP servers: their combined tool catalogue and tool resolution."""

import asyncio
from typing import Any, Callable, Dict, List, NamedTuple, Optional

from .mcp_client import MCPServer

ServerFactory = Callable[[str, Dict[str, Any]], MCPServer]


class Resolution(NamedTuple):
    """Where a tool call goes, or why it cannot go anywhere."""
    server: Optional[MCPServer]
    tool_name: str
    error: Optional[str] = None
    kind: Optional[str] = None


class ServerRegistry:
    def __init__(self, factory: ServerFactory, log: Callable[[str], None]) -> None:
        self._factory = factory
        self._log = log
        self.servers: Dict[str, MCPServer] = {}
        self.catalog: List[Dict[str, Any]] = []
        # Where a server's own messages (a running command's live output) go; set by the bridge.
        self.on_notification: Optional[Callable[[Dict[str, Any]], None]] = None

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def start_all(self, configs: Dict[str, Dict[str, Any]]) -> None:
        self.servers = {server_id: self._factory(server_id, config) for server_id, config in configs.items()}
        for server in self.servers.values():
            if self.on_notification is not None:  # a server may be given its own listener (tests, custom stacks)
                server.on_notification = self.on_notification
            await server.start()
        self.rebuild_catalog()
        self.log_health()

    async def stop_all(self) -> None:
        await asyncio.gather(*(server.stop() for server in self.servers.values()))
        self.servers.clear()
        self.catalog = []

    async def restart(self, configs: Dict[str, Dict[str, Any]]) -> None:
        await self.stop_all()
        await self.start_all(configs)

    async def revive_dead(self) -> bool:
        """Restart any server whose process or reader died. True if anything was restarted."""
        revived = False
        for server in self.servers.values():
            if not server.alive:
                self._log(f"[{server.server_id}] MCP server disconnected; restarting.")
                await server.start()
                revived = True
        if revived:
            self.rebuild_catalog()
            self.log_health()
        return revived

    # ── queries ────────────────────────────────────────────────────────────

    @property
    def any_alive(self) -> bool:
        return any(server.alive for server in self.servers.values())

    def status(self) -> List[Dict[str, Any]]:
        return [
            {"id": server.server_id, "alive": server.alive, "tools": len(server.tools) if server.alive else 0}
            for server in self.servers.values()
        ]

    def rebuild_catalog(self) -> None:
        """Advertise each tool by its bare name, prefixed with "<server>/" only when two servers collide."""
        entries = [(server.server_id, tool) for server in self.servers.values() if server.alive for tool in server.tools]
        counts: Dict[str, int] = {}
        for _, tool in entries:
            counts[tool["name"]] = counts.get(tool["name"], 0) + 1
        self.catalog = [
            {
                "name": f"{server_id}/{tool['name']}" if counts[tool["name"]] > 1 else tool["name"],
                "server": server_id,
                "description": tool.get("description", ""),
                "inputSchema": tool.get("inputSchema", {"type": "object", "properties": {}}),
            }
            for server_id, tool in entries
        ]

    def log_health(self) -> None:
        ids = ", ".join(self.servers) or "none"
        active = ", ".join(server.server_id for server in self.servers.values() if server.alive) or "none"
        self._log(f"configured {len(self.servers)} MCP server(s): {ids}  (active: {active})")
        self._log(f"ready {len(self.catalog)} tools available ({len(self.servers)} MCP server(s))")

    # ── resolution ─────────────────────────────────────────────────────────

    @staticmethod
    def _has_tool(server: MCPServer, name: str) -> bool:
        return server.alive and any(tool["name"] == name for tool in server.tools)

    def resolve(self, name: str) -> Resolution:
        """Find the one live server that owns `name`; "server/tool" addresses a server explicitly."""
        if "/" in name:
            server_id, bare = name.split("/", 1)
            server = self.servers.get(server_id)
            if server and self._has_tool(server, bare):
                return Resolution(server, bare)
        owners = [server for server in self.servers.values() if self._has_tool(server, name)]
        return Resolution(owners[0], name) if len(owners) == 1 else Resolution(None, name)

    def resolve_for_call(self, name: str, selected: Optional[str]) -> Resolution:
        """`resolve`, constrained to the server the user selected (isolation).

        A tool that belongs to any other server is refused, and an ambiguous bare name resolves to
        the selected server when it has that tool. Without a selection the unconstrained rules apply.
        """
        found = self.resolve(name)
        if selected:
            if found.server is None and "/" not in name:
                chosen = self.servers.get(selected)
                if chosen and self._has_tool(chosen, name):
                    found = Resolution(chosen, name)
            if found.server is not None and found.server.server_id != selected:
                return Resolution(None, name, f"MCP tool not available for the selected server: {name}", "unknown_tool")
        if found.server is None:
            return Resolution(None, name, f"Unknown or unavailable MCP tool: {name}", "unknown_tool")
        return found
