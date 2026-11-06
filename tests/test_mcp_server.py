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
        self.assertEqual(len(self.ask("tools/list")["result"]["tools"]), 24)
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

    def test_a_call_runs_in_the_folder_the_chat_is_bound_to_not_the_one_vscode_shows(self):
        other = self.base / "other-project"
        other.mkdir()
        (other / "only-here.txt").write_text("bound", encoding="utf-8")
        self.write("only-in-active.txt", "active")
        bound = self.ask("tools/call", {"name": "read_files", "arguments": {"paths": ["only-here.txt"], "__snapgent_root": str(other)}})
        self.assertIn("bound", bound["result"]["content"][0]["text"])
        info = self.ask("tools/call", {"name": "get_workspace_info", "arguments": {"__snapgent_root": str(other)}})
        self.assertIn("other-project", info["result"]["content"][0]["text"])
        plain = self.ask("tools/call", {"name": "get_workspace_info"})
        self.assertIn("workspace", plain["result"]["content"][0]["text"])

    def test_a_bound_folder_works_while_no_vscode_window_is_open_and_a_missing_one_is_explained(self):
        reply = self.ask("tools/call", {"name": "tree", "arguments": {"__snapgent_root": str(self.root)}}, open_workspace=False)
        self.assertNotIn("error", reply)
        gone = self.ask("tools/call", {"name": "tree", "arguments": {"__snapgent_root": str(self.base / "moved-away")}})
        self.assertIn("cannot be used any more", gone["error"]["message"])
        self.assertIn("Choose the folder again", gone["error"]["message"])

    def test_serve_loop_skips_blank_lines_garbage_and_non_objects(self):
        lines = "\n".join(["", "not json", "[1]", '"s"', json.dumps({"id": 1, "method": "ping"}), json.dumps({"method": "notifications/initialized"})]) + "\n"
        out = io.StringIO()
        self.server().serve(io.StringIO(lines), out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(replies, [{"jsonrpc": "2.0", "id": 1, "result": {}}])

    def test_a_running_command_reports_its_output_as_notifications(self):
        server = self.server()
        pushed = []
        server._notify = pushed.append  # what serve() would wire to stdout
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "run_command",
            "arguments": {"command": sys.executable,
                          "args": ["-c", "import time; print('live', flush=True); time.sleep(1.0)"],
                          "__snapgent_mode": "auto", "__snapgent_job": "job-1"}}}
        server.handle(request)
        streams = [message for message in pushed if message.get("method") == "snapgent/tool_stream"]
        self.assertTrue(streams, "the running command's output must be published before the call finishes")
        self.assertEqual([message["params"]["jobKey"] for message in streams], ["job-1"] * len(streams))
        self.assertEqual([message["params"]["seq"] for message in streams], sorted(m["params"]["seq"] for m in streams))
        self.assertTrue(any("live" in message["params"]["text"] for message in streams))
        # The stream's tracker is released when the call is over, so a reload does not leak one per job.
        self.assertNotIn("job-1", server._stream_sequence)

    def test_no_notifications_without_a_watcher(self):
        pushed = []
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "run_command", "arguments": {"command": sys.executable, "args": ["-c", "print('quiet')"],
                                          "__snapgent_mode": "auto"}}}
        response = self.server().handle(request)
        self.assertEqual(response["result"]["content"][0]["text"], "quiet")

    def test_a_user_stop_is_marked_cancelled_not_errored(self):
        from snapgent_vscode.jobs import CANCELLED_MESSAGE

        def cancelled(*_args):
            raise RuntimeError(CANCELLED_MESSAGE)

        server = McpServer(Workspace(lambda: self.root), call=cancelled)
        request = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "run_command", "arguments": {"command": "x", "__snapgent_mode": "auto", "__snapgent_job": "job-2"}}}
        reply = server.handle(request)
        self.assertNotIn("error", reply)
        self.assertTrue(reply["result"]["structuredContent"]["cancelled"])
        self.assertIn("cancelled by the user", reply["result"]["content"][0]["text"])


class EntryPointTests(unittest.TestCase):
    def test_snapgent_py_vscode_mcp_speaks_mcp_over_stdio(self):
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "bogus"},
        ]
        result = subprocess.run([sys.executable, "snapgent.py", "--vscode-mcp"], cwd=ROOT, input="\n".join(map(json.dumps, requests)) + "\n",
                                capture_output=True, text=True, timeout=20)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2])
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], SERVER_NAME)
        self.assertEqual(replies[1]["error"]["code"], -32601)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
