import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/domain/parser/index.js";

describe("parseToolCalls", () => {
  test("paramless command", () => {
    const calls = P.parseToolCalls('{"command":"list_commands"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "list_commands");
  });

  test("braces inside a string value do not confuse the scanner", () => {
    const calls = P.parseToolCalls('{"command":"write_file","params":{"code":"if x then {y} end"}}');
    assert.equal(calls[0].arguments.code, "if x then {y} end");
  });

  test("legacy tool/arguments schema", () => {
    const calls = P.parseToolCalls('{"tool":"read_file","arguments":{"path":"src/index.js"}}');
    assert.deepEqual(calls, [{ tool: "read_file", arguments: { path: "src/index.js" } }]);
  });

  test("###MCP_TOOL### wrapper", () => {
    const calls = P.parseToolCalls('###MCP_TOOL###\n{"command":"git_status"}\n###END_MCP_TOOL###');
    assert.equal(calls[0].tool, "git_status");
  });

  test("raw TAB inside a string value is tolerated", () => {
    const calls = P.parseToolCalls('{"command":"write_file","params":{"content":"a\tb"}}');
    assert.equal(calls[0].arguments.content, "a\tb");
  });

  test("prose yields no calls", () => {
    assert.deepEqual(P.parseToolCalls("Here is how a command works in theory."), []);
  });
});

describe("detect", () => {
  test("open ###MCP_TOOL### block", () => {
    assert.equal(P.hasOpenToolBlock('###MCP_TOOL###\n{"command":"git_status"'), true);
    assert.equal(P.hasOpenToolBlock('###MCP_TOOL###\n{"command":"git_status"}\n###END_MCP_TOOL###'), false);
  });

  test("open inline JSON command", () => {
    assert.equal(P.hasOpenToolBlock('{"command":"edit_file","params":{"a":1'), true);
  });

  test("signature and shape", () => {
    assert.equal(P.hasToolSignature("Here is how you could use a command in theory."), false);
  });

  test("injected feedback is recognised, command examples inside it are not commands", () => {
    assert.equal(P.isInjectedFeedback("» read_file\n2"), true);
    assert.equal(P.isInjectedFeedback("Output of 'read_file':\n2"), true);
    assert.equal(P.isInjectedFeedback('ERROR: bad JSON, write {"command": "name"}'), true);
  });

  test("tool name while still streaming", () => {
    assert.equal(P.toolNameFromText('{"command":"edit_fi'), "edit_fi");
    assert.equal(P.toolNameFromText("no command here"), "command");
  });
});

describe("salvageCutOff", () => {
  test("one missing root brace", () => {
    const call = P.salvageCutOff('{"command": "edit_file", "params": {"path": "src/admin.js", "edits": [{"old_text": "a", "new_text": "b"}]}');
    assert.equal(call.tool, "edit_file");
    assert.equal(call.arguments.edits.length, 1);
  });

  test("two missing closers", () => {
    const call = P.salvageCutOff('{"command": "git_status", "params": {"verbose": true');
    assert.equal(call.tool, "git_status");
    assert.equal(call.arguments.verbose, true);
  });

  test("refuses a cut in the middle of a string", () => {
    assert.equal(P.salvageCutOff('{"command": "edit_file", "params": {"edits": [{"old_text": "elseif command =='), null);
  });

  test("escaped quotes survive", () => {
    const call = P.salvageCutOff('{"command": "run_command", "params": {"command": "echo \\"hi\\"", "args": []}');
    assert.equal(call.arguments.command, 'echo "hi"');
  });
});

describe("DeepSeek DSML markup", () => {
  const full = [
    "<|DSML|>tool_calls>",
    '<|DSML|>invoke name="read_file">',
    '<|DSML|>parameter name="path" string="true">src/a.js</|DSML|>parameter>',
    "</|DSML|>invoke>",
    "</|DSML|>tool_calls>",
  ].join("\n");

  test("detects the opener in every spelling seen", () => {
    for (const text of [
      full,
      "<|DSML|>tool_calls>\n\n<section>prose</section>",
      '<｜DSML｜>invoke name="read_file">',
      "< |  | DSML |  | tool_calls>",
      "</ |  | DSML |  | parameter>",
      "</|DSML|>parameter>",
    ]) assert.ok(P.DSML_RE.test(text), text);
  });

  test("is a tool signature and is read into a call, marked as native", () => {
    assert.equal(P.hasToolSignature(full), true);
    assert.deepEqual(P.parseToolCalls(full), [{ tool: "read_file", arguments: { path: "src/a.js" }, native: "dsml" }]);
  });

  const seen = [
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="read_files">',
    '<｜｜DSML｜｜ parameter name="paths" string="false">["api/todo/internal/interfaces/responses/pagination.go"]</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="max_total_chars" string="false">2500</｜｜DSML｜｜ parameter>',
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ calls>",
  ].join("\n");

  test("a call seen live: JSON parameters keep their type (list, number)", () => {
    assert.deepEqual(P.parseToolCalls(seen), [{
      tool: "read_files", native: "dsml",
      arguments: { paths: ["api/todo/internal/interfaces/responses/pagination.go"], max_total_chars: 2500 },
    }]);
  });

  test("several invokes are several calls, in order; a string parameter is kept as written", () => {
    const text = '<|DSML|>tool_calls>\n<|DSML|>invoke name="a">\n<|DSML|>parameter name="x" string="true">\nline 1\n  line 2\n</|DSML|>parameter>\n</|DSML|>invoke>\n' +
      '<|DSML|>invoke name="b">\n</|DSML|>invoke>\n</|DSML|>tool_calls>';
    const calls = P.parseToolCalls(text);
    assert.deepEqual(calls.map((c) => c.tool), ["a", "b"]);
    assert.equal(calls[0].arguments.x, "line 1\n  line 2");
  });

  test("still being written: open until the invoke and the calls around it are closed", () => {
    assert.equal(P.hasOpenToolBlock(seen), false);
    assert.equal(P.hasOpenToolBlock(seen.replace(/\n<\/｜｜DSML｜｜ calls>/, "")), true);
    assert.equal(P.hasOpenToolBlock(seen.split("\n").slice(0, 3).join("\n")), true);
    assert.equal(P.hasOpenToolBlock("<｜｜DSML｜｜ inv"), true);
  });

  test("our own command wins when both are written, and another format can be registered", () => {
    const both = `${seen}\n{"command":"tree","params":{}}`;
    assert.deepEqual(P.parseToolCalls(both), [{ tool: "tree", arguments: {} }]);
    P.registerNativeFormat({ id: "demo", recognises: (t) => t.startsWith("CALL "), parse: (t) => [{ tool: t.slice(5), arguments: {} }], isOpen: () => false });
    assert.deepEqual(P.parseToolCalls("CALL tree"), [{ tool: "tree", arguments: {}, native: "demo" }]);
  });

  test("no false positives on prose or a real command", () => {
    assert.equal(P.DSML_RE.test("I considered the DSML invoke and parameter tags, but used JSON instead."), false);
    assert.equal(P.DSML_RE.test('{"command": "read_file", "params": {"path": "x"}}'), false);
  });
});
