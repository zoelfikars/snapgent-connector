import sys
import time
import unittest

from tests.support import mock_config, real_server, temp_dir


class MCPServerProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_list_call_and_stop(self):
        with temp_dir() as tmp:
            server = real_server("mock", mock_config(tmp))
            try:
                self.assertTrue(await server.start())
                self.assertTrue(server.alive and server.ready)
                self.assertEqual([t["name"] for t in server.tools], ["echo"])
                result = await server.call_tool("echo", {"message": "hello"}, 2)
                self.assertEqual(result["content"][0]["text"], "hello")
            finally:
                await server.stop()
            self.assertFalse(server.alive)
            self.assertEqual(server.tools, [])

    async def test_large_response_line_is_received(self):
        # Regression: a single JSON line above asyncio's default 64 KB stream limit used to kill the
        # stdout reader while the process stayed alive, so every later request timed out.
        with temp_dir() as tmp:
            server = real_server("mock", mock_config(tmp))
            try:
                self.assertTrue(await server.start())
                big = "x" * 200_000
                self.assertEqual((await server.call_tool("echo", {"message": big}, 10))["content"][0]["text"], big)
                self.assertTrue(server.alive)
                self.assertEqual((await server.call_tool("echo", {"message": "still works"}, 10))["content"][0]["text"], "still works")
            finally:
                await server.stop()

    async def test_start_is_idempotent_while_alive(self):
        with temp_dir() as tmp:
            server = real_server("mock", mock_config(tmp))
            try:
                await server.start()
                pid = server.process.pid
                self.assertTrue(await server.start())
                self.assertEqual(server.process.pid, pid)
            finally:
                await server.stop()

    async def test_a_server_that_exits_is_reported_dead_and_can_be_restarted(self):
        with temp_dir() as tmp:
            server = real_server("mock", mock_config(tmp))
            try:
                await server.start()
                server.process.kill()
                await server.process.wait()
                self.assertFalse(server.alive)
                with self.assertRaises(RuntimeError):
                    await server.call_tool("echo", {"message": "x"}, 2)
                self.assertTrue(await server.start())
                self.assertEqual((await server.call_tool("echo", {"message": "back"}, 2))["content"][0]["text"], "back")
            finally:
                await server.stop()

    async def test_unknown_method_surfaces_the_server_error(self):
        with temp_dir() as tmp:
            server = real_server("mock", mock_config(tmp))
            try:
                await server.start()
                with self.assertRaisesRegex(RuntimeError, "Method not found"):
                    await server._request("nope", {})
            finally:
                await server.stop()


class LaunchFailureTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, config, expected):
        logs = []
        server = real_server("bad", config, log=logs.append)
        self.assertFalse(await server.start())
        self.assertIn(expected, server.error)
        self.assertTrue(any("[bad]" in line for line in logs))
        self.assertFalse(server.alive)

    async def test_bad_configs_never_spawn_anything(self):
        await self.check({}, "command is missing")
        await self.check({"command": "  "}, "command is missing")
        await self.check({"command": "x", "args": "no"}, "args must be an array")
        await self.check({"command": "x", "args": [1]}, "args must be an array")
        await self.check({"command": "x", "env": []}, "env must be an object")

    async def test_missing_executable(self):
        await self.check({"command": "/definitely/not/a/real/binary"}, "failed to launch")

    async def test_a_process_that_exits_instead_of_speaking_mcp_fails_startup_and_is_cleaned_up(self):
        logs = []
        started = time.monotonic()
        server = real_server("mute", {"command": sys.executable, "args": ["-c", "pass"]}, log=logs.append)
        self.assertFalse(await server.start())
        self.assertFalse(server.alive)
        self.assertIn("MCP startup failed", server.error)
        # Regression: this used to wait out the whole 12 s handshake timeout.
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(any("startup failed" in line for line in logs))


if __name__ == "__main__":
    unittest.main()
