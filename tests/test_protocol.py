import unittest

from snapgent_bridge import protocol


class ParseToolCallTests(unittest.TestCase):
    def test_well_formed(self):
        call = protocol.parse_tool_call({"id": 7, "name": "read_file", "arguments": {"path": "a"}, "timeout": 5000, "server": "vscode"})
        self.assertEqual((call.request_id, call.name, call.arguments, call.timeout_seconds, call.selected_server), (7, "read_file", {"path": "a"}, 5.0, "vscode"))

    def test_missing_arguments_default_to_empty(self):
        self.assertEqual(protocol.parse_tool_call({"id": 1, "name": "x"}).arguments, {})

    def test_malformed(self):
        for request in ({"id": 1}, {"id": 1, "name": 5}, {"id": 1, "name": "x", "arguments": [1]}):
            self.assertIsNone(protocol.parse_tool_call(request), request)

    def test_blank_or_non_string_server_means_no_selection(self):
        for server in ("", None, 3):
            self.assertIsNone(protocol.parse_tool_call({"name": "x", "server": server}).selected_server)


class TimeoutTests(unittest.TestCase):
    def test_clamped_to_one_to_three_hundred_seconds(self):
        self.assertEqual(protocol.clamp_timeout(0), 1.0)
        self.assertEqual(protocol.clamp_timeout(10_000_000), 300.0)
        self.assertEqual(protocol.clamp_timeout(2500), 2.5)

    def test_garbage_falls_back_to_the_default(self):
        for raw in ("soon", None, [1]):
            self.assertEqual(protocol.clamp_timeout(raw), 120.0)


class ResultTests(unittest.TestCase):
    def test_text_and_images_are_split(self):
        text, images = protocol.split_content({"content": [
            {"type": "text", "text": "a"}, {"type": "image", "data": "AAA", "mimeType": "image/jpeg"},
            {"type": "image", "data": "BBB"}, {"type": "text", "text": "b"}, "junk", {"type": "image", "data": 5},
        ]})
        self.assertEqual(text, "a\nb")
        self.assertEqual(images, [{"data": "AAA", "mimeType": "image/jpeg"}, {"data": "BBB", "mimeType": "image/png"}])

    def test_structured_content_is_used_only_when_there_is_no_text(self):
        self.assertEqual(protocol.split_content({"content": [], "structuredContent": {"n": 1}})[0], '{"n": 1}')
        self.assertEqual(protocol.split_content({"content": [{"type": "text", "text": "t"}], "structuredContent": {"n": 1}})[0], "t")

    def test_success_message(self):
        message, text = protocol.tool_result_message(3, {"content": [{"type": "text", "text": "hi"}]})
        self.assertEqual(message, {"type": "tool_result", "id": 3, "ok": True, "text": "hi", "images": []})
        self.assertEqual(text, "hi")

    def test_is_error_becomes_a_failed_result_with_a_fallback_message(self):
        message, _ = protocol.tool_result_message(3, {"isError": True, "content": [{"type": "text", "text": "boom"}]})
        self.assertEqual((message["ok"], message["error"]), (False, "boom"))
        self.assertEqual(protocol.tool_result_message(3, {"isError": True, "content": []})[0]["error"], "MCP tool failed.")


class ConfirmationTests(unittest.TestCase):
    def test_a_confirmation_request_carries_the_token_in_its_own_field(self):
        result = {"isError": True, "content": [{"type": "text", "text": "CONFIRMATION_REQUIRED: Delete file: a"}],
                  "structuredContent": {"confirmation": {"token": "t0k", "description": "Delete file: a", "tool": "delete_file", "risk": "destructive"}}}
        message, text = protocol.tool_result_message(5, result)
        self.assertEqual((message["ok"], message["kind"], message["id"]), (False, "confirmation_required", 5))
        self.assertEqual(message["confirmation"]["token"], "t0k")
        self.assertNotIn("t0k", message["error"], "the token must not be in the text")
        self.assertNotIn("t0k", text)

    def test_ordinary_errors_have_no_confirmation(self):
        message, _ = protocol.tool_result_message(1, {"isError": True, "content": [{"type": "text", "text": "boom"}], "structuredContent": {"other": 1}})
        self.assertNotIn("confirmation", message)
        self.assertNotIn("kind", message)

    def test_a_confirmation_field_on_a_successful_result_is_ignored(self):
        message, _ = protocol.tool_result_message(1, {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"confirmation": {"token": "x"}}})
        self.assertEqual((message["ok"], "confirmation" in message), (True, False))


class MessageShapeTests(unittest.TestCase):
    def test_connected_and_tools_share_a_body(self):
        connected = protocol.connected_message("1.2", True, [{"name": "a"}], [{"id": "s"}])
        self.assertEqual(connected["type"], "connected")
        tools = protocol.tools_message(connected, 9)
        self.assertEqual((tools["type"], tools["id"], tools["tools"]), ("tools", 9, [{"name": "a"}]))

    def test_error_messages(self):
        self.assertNotIn("id", protocol.error_message(None, "bad"))
        self.assertEqual(protocol.error_message(4, "bad")["id"], 4)
        self.assertEqual(protocol.tool_error(1, "x", "timeout")["kind"], "timeout")
        self.assertNotIn("kind", protocol.tool_error(1, "x"))

    def test_status_and_server_changed(self):
        ok = protocol.mcp_status_message(1, True, True, [], [])
        self.assertEqual((ok["ok"], "error" in ok), (True, False))
        bad = protocol.mcp_status_message(1, False, False, error="no")
        self.assertEqual((bad["ok"], bad["error"], "tools" in bad), (False, "no", False))
        self.assertEqual(protocol.server_changed_message(1, True), {"type": "server_changed", "id": 1, "ok": True, "restarting": False})
        self.assertEqual(protocol.server_changed_message(1, False, "e")["error"], "e")

    def test_json_line_is_compact_and_keeps_unicode(self):
        self.assertEqual(protocol.json_line({"a": "é", "b": [1, 2]}), '{"a":"é","b":[1,2]}')


if __name__ == "__main__":
    unittest.main()
