import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from snapgent_bridge.config import ConfigStore
from snapgent_bridge.router import RequestRouter
from tests.support import Recorder, fake_registry, fake_server


_TEMP_DIRS = []


def tearDownModule():
    for tmp in _TEMP_DIRS:
        tmp.cleanup()


def make(servers=None, config_path=None):
    registry = fake_registry(servers or {"snapgent": fake_server("snapgent", ["read_file", "git_status"])})
    broadcasts = Recorder()
    logs = []
    tmp = None
    if config_path is None:
        tmp = tempfile.TemporaryDirectory()
        _TEMP_DIRS.append(tmp)
        config_path = Path(tmp.name) / "config.json"
    router = RequestRouter(registry, ConfigStore(config_path), broadcasts, "9.9", logs.append)
    return router, registry, broadcasts, logs, tmp


async def ask(router, request):
    replies = Recorder()
    await router.handle(request, replies)
    return replies.sent


class BasicRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_ping_echoes_the_id(self):
        router, *_ = make()
        self.assertEqual(await ask(router, {"type": "ping", "id": 5}), [{"type": "pong", "id": 5}])

    async def test_list_tools_returns_the_catalogue_and_server_health(self):
        router, *_ = make()
        [reply] = await ask(router, {"type": "list_tools", "id": 2})
        self.assertEqual((reply["type"], reply["id"], reply["bridge_version"], reply["mcp_alive"]), ("tools", 2, "9.9", True))
        self.assertEqual([t["name"] for t in reply["tools"]], ["read_file", "git_status"])
        self.assertEqual(reply["servers"], [{"id": "snapgent", "alive": True, "tools": 2}])

    async def test_unknown_request_types_are_reported(self):
        router, *_ = make()
        [reply] = await ask(router, {"type": "explode", "id": 1})
        self.assertEqual((reply["type"], reply["id"]), ("error", 1))
        self.assertIn("Unknown bridge request: explode", reply["error"])

    async def test_missing_type_is_an_unknown_request_too(self):
        router, *_ = make()
        [reply] = await ask(router, {"id": 1})
        self.assertEqual(reply["type"], "error")


class CallToolTests(unittest.IsolatedAsyncioTestCase):
    def stub(self, registry, result=None, error=None):
        calls = []

        async def call_tool(name, arguments, timeout):
            calls.append((name, arguments, timeout))
            if error:
                raise error
            return result

        registry.servers["snapgent"].call_tool = call_tool
        return calls

    async def test_success_returns_text(self):
        router, registry, _, logs, _ = make()
        calls = self.stub(registry, {"content": [{"type": "text", "text": "file body"}]})
        [reply] = await ask(router, {"type": "call_tool", "id": 1, "name": "read_file", "arguments": {"path": "a"}, "timeout": 5000})
        self.assertEqual(reply, {"type": "tool_result", "id": 1, "ok": True, "text": "file body", "images": []})
        self.assertEqual(calls, [("read_file", {"path": "a"}, 5.0)])
        # Successful calls are no longer logged with their result preview (log spam).

    async def test_tool_reported_errors_become_failed_results(self):
        router, registry, *_ = make()
        self.stub(registry, {"isError": True, "content": [{"type": "text", "text": "no such file"}]})
        [reply] = await ask(router, {"type": "call_tool", "id": 1, "name": "read_file"})
        self.assertEqual((reply["ok"], reply["error"]), (False, "no such file"))

    async def test_timeouts_and_other_failures_get_distinct_kinds(self):
        router, registry, _, logs, _ = make()
        self.stub(registry, error=asyncio.TimeoutError())
        [timeout] = await ask(router, {"type": "call_tool", "id": 1, "name": "read_file"})
        self.assertEqual(timeout["kind"], "timeout")
        self.stub(registry, error=RuntimeError("server went away"))
        [failed] = await ask(router, {"type": "call_tool", "id": 2, "name": "read_file"})
        self.assertEqual((failed["kind"], failed["error"]), ("tool_error", "server went away"))
        self.assertTrue(any("ERROR: server went away" in line for line in logs))

    async def test_invalid_calls_are_rejected_without_touching_a_server(self):
        router, registry, *_ = make()
        calls = self.stub(registry, {"content": []})
        for request in ({"type": "call_tool", "id": 1}, {"type": "call_tool", "id": 2, "name": "x", "arguments": "bad"}):
            [reply] = await ask(router, request)
            self.assertEqual((reply["ok"], reply["error"]), (False, "Invalid tool call."))
        self.assertEqual(calls, [])

    async def test_unknown_tool_and_wrong_server_are_refused_before_calling(self):
        router, registry, *_ = make({"snapgent": fake_server("snapgent", ["read_file"]), "other": fake_server("other", ["secret"])})
        calls = self.stub(registry, {"content": []})
        [unknown] = await ask(router, {"type": "call_tool", "id": 1, "name": "nope"})
        self.assertEqual((unknown["kind"], unknown["ok"]), ("unknown_tool", False))
        [isolated] = await ask(router, {"type": "call_tool", "id": 2, "name": "secret", "server": "snapgent"})
        self.assertIn("not available for the selected server", isolated["error"])
        self.assertEqual(calls, [])


class ServerManagementTests(unittest.IsolatedAsyncioTestCase):
    async def test_add_server_persists_restarts_replies_and_broadcasts(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "config.json"
        router, registry, broadcasts, *_ = make(config_path=path)
        restarted = []

        async def restart(configs):
            restarted.append(sorted(configs))

        registry.restart = restart
        [reply] = await ask(router, {"type": "add_server", "id": 3, "server_id": "extra", "command": "node", "args": ["s.js"], "env": {}})
        self.assertEqual(reply, {"type": "server_changed", "id": 3, "ok": True, "restarting": False})
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["extra"]["command"], "node")
        self.assertEqual(restarted, [["extra"]])
        self.assertEqual(broadcasts.sent[0]["type"], "connected")

    async def test_invalid_changes_reply_with_the_reason_and_do_not_restart_or_broadcast(self):
        router, registry, broadcasts, *_ = make()

        async def restart(configs):
            raise AssertionError("must not restart")

        registry.restart = restart
        for request, message in (
            ({"type": "add_server", "id": 1, "server_id": "bad id", "command": "x"}, "Invalid MCP server id."),
            ({"type": "add_server", "id": 2, "server_id": "ok", "command": ""}, "MCP server command is required."),
            ({"type": "add_server", "id": 3, "server_id": "ok", "command": "x", "args": "no"}, "args must be an array"),
            ({"type": "remove_server", "id": 4, "server_id": "snapgent"}, "cannot be removed"),
        ):
            [reply] = await ask(router, request)
            self.assertFalse(reply["ok"])
            self.assertIn(message, reply["error"])
        self.assertEqual(broadcasts.sent, [])

    async def test_remove_server(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "config.json"
        path.write_text(json.dumps({"mcpServers": {"extra": {"command": "x"}}}), encoding="utf-8")
        router, registry, *_ = make(config_path=path)

        async def restart(configs):
            pass

        registry.restart = restart
        [reply] = await ask(router, {"type": "remove_server", "id": 1, "server_id": "extra"})
        self.assertTrue(reply["ok"])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["mcpServers"], {})

    async def test_restart_mcp_reports_status_and_broadcasts(self):
        router, registry, broadcasts, *_ = make()
        restarts = []

        async def restart(configs):
            restarts.append(configs)

        registry.restart = restart
        [reply] = await ask(router, {"type": "restart_mcp", "id": 9})
        self.assertEqual((reply["type"], reply["id"], reply["ok"], reply["alive"]), ("mcp_status", 9, True, True))
        self.assertEqual(len(restarts), 1)
        self.assertEqual(len(broadcasts.sent), 1)

    async def test_restart_failure_is_reported_not_raised(self):
        router, registry, broadcasts, *_ = make()

        async def restart(configs):
            raise RuntimeError("config.json is broken")

        registry.restart = restart
        [reply] = await ask(router, {"type": "restart_mcp", "id": 9})
        self.assertEqual((reply["ok"], reply["alive"], reply["error"]), (False, False, "config.json is broken"))
        self.assertEqual(len(broadcasts.sent), 1)


if __name__ == "__main__":
    unittest.main()
