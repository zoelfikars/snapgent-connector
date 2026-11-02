import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

from snapgent_vscode import SERVER_NAME, protocol
from snapgent_vscode.server import McpServer
from snapgent_vscode.workspace import Workspace
from tests.vscode_support import WorkspaceCase

ROOT = Path(__file__).resolve().parent.parent / "server"


class ProtocolTests(unittest.TestCase):
    def test_messages(self):
        self.assertEqual(protocol.result(1, {"a": 1}), {"jsonrpc": "2.0", "id": 1, "result": {"a": 1}})
        self.assertEqual(protocol.error(2, -1, "x"), {"jsonrpc": "2.0", "id": 2, "error": {"code": -1, "message": "x"}})
        self.assertEqual(protocol.initialize_result("n", "v")["serverInfo"], {"name": "n", "version": "v"})

    def test_tool_output_keeps_text_for_the_model_and_value_for_programs(self):
        self.assertEqual(protocol.tool_output("hi")["content"][0]["text"], "hi")
        out = protocol.tool_output({"é": [1]})
        self.assertEqual(json.loads(out["content"][0]["text"]), {"é": [1]})
        self.assertEqual(out["structuredContent"], {"result": {"é": [1]}})

    def test_encode_is_one_compact_line(self):
        self.assertEqual(protocol.encode({"a": "é", "b": [1]}), '{"a":"é","b":[1]}')


class ServerTests(WorkspaceCase):
    def server(self, open_workspace=True):
        return McpServer(Workspace(lambda: self.root if open_workspace else None))

    def ask(self, method, params=None, request_id=1, **server_options):
        return self.server(**server_options).handle({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})

    def test_initialize_and_ping(self):
        reply = self.ask("initialize")
        self.assertEqual(reply["result"]["serverInfo"]["name"], SERVER_NAME)
        self.assertEqual(self.ask("ping")["result"], {})

    def test_tools_list_is_empty_when_no_workspace_is_open(self):
        self.assertEqual(len(self.ask("tools/list")["result"]["tools"]), 23)
        self.assertEqual(self.ask("tools/list", open_workspace=False)["result"]["tools"], [])

    def test_notifications_get_no_reply(self):
        self.assertIsNone(self.ask("notifications/initialized"))

    def test_unknown_method(self):
        reply = self.ask("nope", request_id=9)
        self.assertEqual((reply["id"], reply["error"]["code"]), (9, -32601))

    def test_a_tool_call_returns_text_and_structured_content(self):
        self.write("a.txt", "hello")
        reply = self.ask("tools/call", {"name": "read_files", "arguments": {"paths": ["a.txt"]}})
        self.assertIn("hello", reply["result"]["content"][0]["text"])
        self.assertIn("hello", reply["result"]["structuredContent"]["result"])

    def test_every_failure_becomes_a_readable_error_reply(self):
        reply = self.ask("tools/call", {"name": "read_files", "arguments": {"paths": ["../x"]}})
        self.assertIn("escapes workspace", reply["result"]["content"][0]["text"])
        for params, text in (
            ({"name": "read_files", "arguments": {}}, "Missing required"),
            ({"name": "nope"}, "Unknown tool"),
            ({"arguments": {}}, "Unknown tool"),
        ):
            reply = self.ask("tools/call", params)
            self.assertEqual(reply["error"]["code"], -32603)
            self.assertIn(text, reply["error"]["message"])

    def test_tool_calls_without_a_workspace_explain_what_to_do(self):
        reply = self.ask("tools/call", {"name": "tree"}, open_workspace=False)
        self.assertIn("Open a project folder in VS Code", reply["error"]["message"])

    def test_serve_loop_skips_blank_lines_garbage_and_non_objects(self):
        lines = "\n".join(["", "not json", "[1]", '"s"', json.dumps({"id": 1, "method": "ping"}), json.dumps({"method": "notifications/initialized"})]) + "\n"
        out = io.StringIO()
        self.server().serve(io.StringIO(lines), out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{"jsonrpc": "2.0", "id": 1, "result": {}}])


class EntryPointTests(unittest.TestCase):
    def test_vscode_mcp_py_speaks_mcp_over_stdio(self):
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "bogus"},
        ]
        result = subprocess.run([sys.executable, "vscode_mcp.py"], cwd=ROOT, input="\n".join(map(json.dumps, requests)) + "\n",
                                capture_output=True, text=True, timeout=20)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2])
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], SERVER_NAME)
        self.assertEqual(replies[1]["error"]["code"], -32601)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
