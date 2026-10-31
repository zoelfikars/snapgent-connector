"""Shared fixtures for the bridge tests."""

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

from snapgent_bridge.mcp_client import MCPServer
from snapgent_bridge.registry import ServerRegistry

MOCK_MCP = r"""
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "mock", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Echo a message", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": request["params"]["arguments"]["message"]}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"""


def write_mock(directory: str) -> Path:
    path = Path(directory) / "mock_mcp.py"
    path.write_text(MOCK_MCP, encoding="utf-8")
    return path


def mock_config(directory: str) -> Dict[str, Any]:
    return {"command": sys.executable, "args": [str(write_mock(directory))], "env": {}}


def real_server(server_id: str, config: Dict[str, Any], log=lambda _m: None) -> MCPServer:
    return MCPServer(server_id, config, cwd=Path.cwd(), client_version="test", log=log)


def fake_server(server_id: str, tool_names: List[str], alive: bool = True) -> MCPServer:
    """An MCPServer that looks alive with the given tools, without spawning anything."""
    server = MCPServer(server_id, {}, cwd=Path.cwd(), client_version="test", log=lambda _m: None)
    if alive:
        server.process = SimpleNamespace(returncode=None)
    server.ready = alive
    server.tools = [{"name": name, "description": f"{name} tool"} for name in tool_names]
    return server


def fake_registry(servers: Dict[str, MCPServer]) -> ServerRegistry:
    registry = ServerRegistry(lambda server_id, config: servers[server_id], lambda _m: None)
    registry.servers = dict(servers)
    registry.rebuild_catalog()
    return registry


class Recorder:
    """Collects replies the router sends."""

    def __init__(self) -> None:
        self.sent: List[Dict[str, Any]] = []

    async def __call__(self, message: Dict[str, Any]) -> None:
        self.sent.append(message)


def temp_dir():
    return tempfile.TemporaryDirectory()


def run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


__all__ = ["json"]
