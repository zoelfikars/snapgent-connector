import asyncio
import json
import unittest
from pathlib import Path

from snapgent_bridge import server as bridge_server
from snapgent_bridge.config import ConfigStore
from snapgent_bridge.trust import TrustPolicy, TrustStore
from tests.support import mock_config, real_server, temp_dir

websockets = bridge_server.websockets
EXTENSION = "chrome-extension://abcdefghijklmnop"


@unittest.skipIf(websockets is None, "websockets package is not installed")
class WebSocketServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = temp_dir()
        self.tmp = self._tmp.name
        path = Path(self.tmp) / "config.json"
        path.write_text(json.dumps({"mcpServers": {"mock": mock_config(self.tmp)}}), encoding="utf-8")
        registry = bridge_server.ServerRegistry(lambda i, c: real_server(i, c), lambda _m: None)
        self.asked = []

        async def ask(origin):
            self.asked.append(origin)
            return origin == EXTENSION

        self.trust = TrustPolicy(TrustStore(None), [], ask, lambda _m: None)
        self.bridge = bridge_server.BridgeServer(registry, ConfigStore(path), lambda _m: None, trust=self.trust)
        await self.bridge.start_servers()
        self.listener = await websockets.serve(self.bridge.handle_client, "127.0.0.1", 0)
        self.port = self.listener.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.listener.close()
        await self.listener.wait_closed()
        await self.bridge.stop_servers()
        self._tmp.cleanup()

    async def approve(self):
        """The user answers 'yes' to the question about EXTENSION (the first attempt starts it)."""
        try:
            async with self.connect() as first:
                await asyncio.wait_for(first.recv(), 2)
        except websockets.ConnectionClosed:
            pass
        for _ in range(20):
            await asyncio.sleep(0.01)

    def connect(self, origin=EXTENSION):
        kwargs = {"origin": origin} if origin else {}
        return websockets.connect(f"ws://127.0.0.1:{self.port}", **kwargs)

    async def recv(self, client):
        return json.loads(await asyncio.wait_for(client.recv(), 5))

    async def test_extension_gets_the_catalogue_on_connect_and_can_call_a_tool(self):
        await self.approve()
        async with self.connect() as client:
            connected = await self.recv(client)
            self.assertEqual(connected["type"], "connected")
            self.assertEqual(connected["servers"], [{"id": "mock", "alive": True, "tools": 1}])
            await client.send(json.dumps({"id": 1, "type": "list_tools"}))
            tools = await self.recv(client)
            self.assertEqual((tools["type"], tools["tools"][0]["server"]), ("tools", "mock"))
            await client.send(json.dumps({"id": 2, "type": "call_tool", "name": "echo", "arguments": {"message": "round trip"}, "timeout": 2000, "server": "mock"}))
            result = await self.recv(client)
            self.assertEqual((result["ok"], result["text"], result["id"]), (True, "round trip", 2))

    async def test_web_pages_and_clients_without_an_origin_are_closed_with_1008(self):
        for origin in ("https://evil.example", "http://127.0.0.1:3000", None):
            async with self.connect(origin) as client:
                with self.assertRaises(websockets.ConnectionClosed) as caught:
                    await client.recv()
                self.assertEqual(caught.exception.rcvd.code, 1008, origin)
        self.assertEqual(self.bridge.clients, set())

    async def test_an_unknown_extension_is_turned_away_until_the_user_approves_it(self):
        async with self.connect("chrome-extension://stranger") as client:
            with self.assertRaises(websockets.ConnectionClosed) as caught:
                await client.recv()
            self.assertEqual(caught.exception.rcvd.code, 1008)
            self.assertIn("not approved", caught.exception.rcvd.reason)
        await asyncio.sleep(0.05)
        self.assertEqual(self.asked, ["chrome-extension://stranger"])
        async with self.connect("chrome-extension://stranger") as client:
            with self.assertRaises(websockets.ConnectionClosed):
                await client.recv()
        self.assertEqual(self.asked, ["chrome-extension://stranger"], "asked once")
        await self.approve()
        async with self.connect() as client:
            self.assertEqual((await self.recv(client))["type"], "connected")

    async def test_pinned_origin_rejects_other_extensions(self):
        import os
        os.environ["ZS_ALLOWED_ORIGINS"] = "chrome-extension://only-this-one"
        self.addCleanup(os.environ.pop, "ZS_ALLOWED_ORIGINS", None)
        async with self.connect() as client:
            with self.assertRaises(websockets.ConnectionClosed) as caught:
                await client.recv()
            self.assertEqual(caught.exception.rcvd.code, 1008)

    async def test_malformed_requests_get_an_error_and_the_connection_survives(self):
        await self.approve()
        async with self.connect() as client:
            await self.recv(client)
            await client.send("not json")
            self.assertEqual((await self.recv(client))["error"], "Invalid JSON request.")
            await client.send("[1, 2]")
            self.assertEqual((await self.recv(client))["error"], "Request must be a JSON object.")
            await client.send(json.dumps({"type": "ping", "id": 1}))
            self.assertEqual((await self.recv(client))["type"], "pong")

    async def test_clients_are_tracked_and_released(self):
        await self.approve()
        async with self.connect() as client:
            await self.recv(client)
            self.assertEqual(len(self.bridge.clients), 1)
        for _ in range(50):
            if not self.bridge.clients:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(self.bridge.clients, set())

    async def test_broadcast_reaches_every_client_even_if_one_is_gone(self):
        await self.approve()
        async with self.connect() as a, self.connect() as b:
            await self.recv(a)
            await self.recv(b)

            class Dead:
                async def send(self, _):
                    raise ConnectionError("gone")

            self.bridge.clients.add(Dead())
            await self.bridge.broadcast({"type": "hello"})
            self.assertEqual((await self.recv(a))["type"], "hello")
            self.assertEqual((await self.recv(b))["type"], "hello")

    async def test_a_crashed_mcp_server_is_revived_and_clients_are_told(self):
        await self.approve()
        async with self.connect() as client:
            await self.recv(client)
            server = self.bridge.registry.servers["mock"]
            server.process.kill()
            await server.process.wait()
            self.assertFalse(server.alive)
            from snapgent_bridge import settings
            original = settings.MONITOR_INTERVAL_SECONDS
            settings.MONITOR_INTERVAL_SECONDS = 0.05
            self.addCleanup(setattr, settings, "MONITOR_INTERVAL_SECONDS", original)
            monitor = asyncio.create_task(self.bridge.monitor())
            try:
                update = await self.recv(client)
            finally:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            self.assertEqual(update["type"], "connected")
            self.assertEqual(update["servers"], [{"id": "mock", "alive": True, "tools": 1}])


class ParseTests(unittest.TestCase):
    def test_parse(self):
        parse = bridge_server.BridgeServer._parse
        self.assertEqual(parse('{"a": 1}'), {"a": 1})
        self.assertEqual(parse("nope"), "Invalid JSON request.")
        self.assertEqual(parse(None), "Invalid JSON request.")
        self.assertEqual(parse("3"), "Request must be a JSON object.")


if __name__ == "__main__":
    unittest.main()
