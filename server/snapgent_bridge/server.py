"""The WebSocket server: accepts extension connections and routes their requests."""

import asyncio
import json
import signal
import sys
from typing import Any, Dict, Optional

from . import BRIDGE_VERSION, settings, protocol
from .config import ConfigStore
from .logs import configure as configure_logging, log, notice
from .mcp_client import MCPServer
from .protocol import error_message, json_line
from .registry import ServerRegistry
from .router import RequestRouter
from .security import origin_allowed, request_origin
from .trust import TrustPolicy, TrustStore, ask_in_terminal

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

    def __init__(self, registry: ServerRegistry, config: ConfigStore, log_fn=log, trust: Optional[TrustPolicy] = None) -> None:
        self.registry = registry
        self.config = config
        self._log = log_fn
        self._trust = trust or TrustPolicy(TrustStore(None), settings.pinned_origins(), ask_in_terminal, log_fn)
        self.clients = set()
        self._lock_: Optional[asyncio.Lock] = None
        self.router = RequestRouter(registry, config, self.broadcast, BRIDGE_VERSION, log_fn)
        # A running command's live output comes from the MCP server as a notification: forward it to the extension.
        self.registry.on_notification = self._mcp_notification

    @property
    def _lock(self) -> asyncio.Lock:
        # Made on first use inside the running loop (Python 3.9 binds a Lock to the loop current at creation).
        if self._lock_ is None:
            self._lock_ = asyncio.Lock()
        return self._lock_

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

    def _mcp_notification(self, message: Dict[str, Any]) -> None:
        """A server's own message: only live command output is forwarded, and never on the reader's thread."""
        if message.get("method") != "snapgent/tool_stream":
            return
        params = message.get("params")
        if not isinstance(params, dict):
            return
        try:
            asyncio.get_running_loop().create_task(self.broadcast(protocol.tool_stream(None, params)))
        except RuntimeError:  # no loop (shutting down): nothing to forward to
            pass

    async def handle_client(self, websocket: Any, _path: Optional[str] = None) -> None:
        origin = request_origin(websocket)
        if not origin_allowed(origin, settings.pinned_origins()):
            self._log(f"rejected connection with origin {origin!r}")
            await websocket.close(1008, "origin not allowed")
            return
        if not self._trust.allows(origin):
            # Do not log here: the extension retries every few seconds and the rejection would flood the
            # terminal, burying the question TrustPolicy is asking. Approval/refusal is logged once.
            await websocket.close(1008, "extension not approved: answer the question in the terminal running the bridge")
            return
        async with self._lock:
            self.clients.add(websocket)
        self._log("extension connected")
        await self._send(websocket, self.router.connected_message())

        async def reply(message: Dict[str, Any]) -> None:
            await self._send(websocket, message)

        # Each request runs on its own task: a tool that takes a minute (a docker build) must not stop the bridge from
        # answering the extension's pings meanwhile, or the extension decides the socket is dead and drops the call.
        running = set()

        async def handle(request: Dict[str, Any]) -> None:
            try:
                await self.router.handle(request, reply)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # one bad request must not end the connection
                self._log(f"request failed: {error}")
                await reply(error_message(request.get("id"), f"Bridge error: {error}"))

        try:
            async for raw in websocket:
                request = self._parse(raw)
                if isinstance(request, str):
                    await reply(error_message(None, request))
                    continue
                task = asyncio.ensure_future(handle(request))
                running.add(task)
                task.add_done_callback(running.discard)
        finally:
            for task in list(running):
                task.cancel()
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
    trust = TrustPolicy(TrustStore(settings.TRUSTED_ORIGINS_PATH), settings.pinned_origins(), ask_in_terminal, log)
    bridge = BridgeServer(build_registry(), ConfigStore(settings.CONFIG_PATH), trust=trust)
    await bridge.start_servers()
    server = await websockets.serve(
        bridge.handle_client, settings.HOST, settings.PORT,
        max_size=settings.WS_MAX_MESSAGE_BYTES, ping_interval=20, ping_timeout=20,
    )
    log(f"snapgent bridge v{BRIDGE_VERSION}")
    notice(f"  Listening on ws://{settings.HOST}:{settings.PORT} - load the extension and open a supported AI chat.")
    notice(f"  Details are written to {settings.LOG_PATH}")
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
        notice("bridge stopped")


def main() -> None:
    try:
        asyncio.run(run())
    except (OSError, RuntimeError, ValueError) as error:
        notice(f"FATAL: {error}")
        raise SystemExit(1)
