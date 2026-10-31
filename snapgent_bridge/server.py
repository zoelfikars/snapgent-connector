"""The WebSocket server: accepts extension connections and routes their requests."""

import asyncio
import json
import signal
import sys
from typing import Any, Dict, Optional

from . import BRIDGE_VERSION, settings
from .config import ConfigStore
from .logs import configure as configure_logging, log
from .mcp_client import MCPServer
from .protocol import error_message, json_line
from .registry import ServerRegistry
from .router import RequestRouter
from .security import origin_allowed, request_origin

try:
    import websockets
except ImportError:  # reported with install instructions in `run`
    websockets = None


def build_registry(log_fn=log) -> ServerRegistry:
    return ServerRegistry(
        lambda server_id, config: MCPServer(server_id, config, cwd=settings.ROOT, client_version=BRIDGE_VERSION, log=log_fn),
        log_fn,
    )


class BridgeServer:
    """Owns the connected extension sockets. Everything else is delegated."""

    def __init__(self, registry: ServerRegistry, config: ConfigStore, log_fn=log) -> None:
        self.registry = registry
        self.config = config
        self._log = log_fn
        self.clients = set()
        self._lock = asyncio.Lock()
        self.router = RequestRouter(registry, config, self.broadcast, BRIDGE_VERSION, log_fn)

    async def start_servers(self) -> None:
        await self.registry.start_all(self.config.load_servers())

    async def stop_servers(self) -> None:
        await self.registry.stop_all()

    async def _send(self, client: Any, message: Dict[str, Any]) -> None:
        try:
            await client.send(json_line(message))
        except Exception:  # a client that vanished mid-send must not break the others
            pass

    async def broadcast(self, message: Dict[str, Any]) -> None:
        async with self._lock:
            clients = list(self.clients)
        if clients:
            await asyncio.gather(*(self._send(client, message) for client in clients), return_exceptions=True)

    async def handle_client(self, websocket: Any, _path: Optional[str] = None) -> None:
        origin = request_origin(websocket)
        if not origin_allowed(origin, settings.pinned_origins()):
            self._log(f"rejected connection with origin {origin!r}")
            await websocket.close(1008, "origin not allowed")
            return
        async with self._lock:
            self.clients.add(websocket)
        self._log("extension connected")
        await self._send(websocket, self.router.connected_message())

        async def reply(message: Dict[str, Any]) -> None:
            await self._send(websocket, message)

        try:
            async for raw in websocket:
                request = self._parse(raw)
                if isinstance(request, str):
                    await reply(error_message(None, request))
                else:
                    await self.router.handle(request, reply)
        finally:
            async with self._lock:
                self.clients.discard(websocket)
            self._log("extension disconnected")

    @staticmethod
    def _parse(raw: Any):
        """The request dict, or an error string."""
        try:
            request = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return "Invalid JSON request."
        return request if isinstance(request, dict) else "Request must be a JSON object."

    async def monitor(self) -> None:
        """Restart MCP servers that died, and tell the extension when the catalogue changed."""
        while True:
            await asyncio.sleep(settings.MONITOR_INTERVAL_SECONDS)
            if await self.registry.revive_dead():
                await self.broadcast(self.router.connected_message())


async def run() -> None:
    if websockets is None:
        raise RuntimeError(
            "The 'websockets' package is required. Install it with "
            f"'{sys.executable} -m pip install websockets'."
        )
    configure_logging(settings.LOG_PATH)
    bridge = BridgeServer(build_registry(), ConfigStore(settings.CONFIG_PATH))
    await bridge.start_servers()
    server = await websockets.serve(
        bridge.handle_client, settings.HOST, settings.PORT,
        max_size=settings.WS_MAX_MESSAGE_BYTES, ping_interval=20, ping_timeout=20,
    )
    log(f"snapgent bridge v{BRIDGE_VERSION}")
    log(f"listening on ws://{settings.HOST}:{settings.PORT} - load the extension and open a supported AI chat")
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    monitor_task = asyncio.create_task(bridge.monitor())
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stop_event.wait()
    finally:
        monitor_task.cancel()
        await asyncio.gather(monitor_task, return_exceptions=True)
        server.close()
        await server.wait_closed()
        await bridge.stop_servers()
        log("bridge stopped")


def main() -> None:
    try:
        asyncio.run(run())
    except (OSError, RuntimeError, ValueError) as error:
        log(f"FATAL: {error}")
        raise SystemExit(1)
