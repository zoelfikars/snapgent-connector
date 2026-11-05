import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply, looksLikeCommand } from "../src/domain/agent/reply-classifier.js";

const item = { id: "turn" };
const classify = (reply, over = {}) =>
  classifyReply(reply, { item, hasContinueButton: () => false, knowsTool: (n) => ["read_file", "edit_file"].includes(n), catalogueSize: 2, ...over });
const kindOf = (reply, over) => classify(reply, over).result.kind;
const reasonOf = (reply, over) => classify(reply, over).result.reason;

describe("classifyReply: commands", () => {
  test("a valid command", () => {
    const { result } = classify('{"command":"read_file","params":{"path":"a.js"}}');
    assert.deepEqual([result.kind, result.calls[0].tool, result.item], ["tool", "read_file", item]);
  });

  test("a command cut off only by its trailing closers is salvaged and runs", () => {
    const { result, diags } = classify('{"command":"edit_file","params":{"path":"a.js","edits":[{"old_text":"a","new_text":"b"}]}');
    assert.equal(result.kind, "tool");
    assert.deepEqual(diags, [["tool.salvaged", { name: "edit_file" }]]);
  });

  test("an opener cut mid-string is an 'unclosed' rewrite request", () => {
    assert.equal(reasonOf('{"command":"edit_file","params":{"edits":[{"old_text":"abc'), "unclosed");
  });

  test("a truncated command with the site's Continue button is 'truncated', not a parse error", () => {
    assert.equal(kindOf('{"command":"edit_file","params":{"edits":[{"old_text":"abc', { hasContinueButton: () => true }), "truncated");
  });

  test("a broken ###MCP_TOOL### block is 'malformed'", () => {
    assert.equal(reasonOf("###MCP_TOOL###\nnot json at all\n###END_MCP_TOOL###"), "malformed");
  });

  test("a closed envelope naming a real tool that failed to parse is 'malformed'; naming an unknown tool is just text", () => {
    assert.equal(reasonOf('{"command":"read_file","params":{"path":"a "b" c"}}'), "malformed");
    assert.equal(kindOf('{"command":"command_name","params":{"x":"a "b" c"}}'), "text");
  });
});

describe("classifyReply: model dialects", () => {
  test("DeepSeek DSML markup", () => {
    const { result, diags } = classify('<|DSML|>tool_calls>\n<|DSML|>invoke name="x">'); // cut off: not readable, so the DSML note, not "unclosed"
    assert.equal(result.reason, "dsml");
    assert.equal(diags[0][0], "cmd.dsml");
  });

  test("raw arguments without the envelope", () => {
    assert.equal(reasonOf('{"path":"a.js","edits":[{"old_text":"a","new_text":"b"}]}'), "envelope");
  });

  test("wrong key naming a known tool is 'toolKey'; an unknown tool is a plain answer and is logged", () => {
    assert.equal(reasonOf('{"toolName":"read_file","path":"a.js"}'), "toolKey");
    const { result, diags } = classify('{"toolName":"mystery","path":"a.js"}');
    assert.equal(result.kind, "text");
    assert.deepEqual(diags, [["cmd.wrongKey", { name: "mystery", known: false, catalogue: 2 }]]);
  });
});

describe("classifyReply: everything else", () => {
  test("plain text, empty, and truncated-by-length", () => {
    assert.deepEqual(classify("All done.").result, { kind: "text", text: "All done." });
    assert.equal(kindOf(""), "empty");
    assert.deepEqual(classify("", {}).diags, [["empty.why", { branch: "finalBlank" }]]);
    assert.equal(kindOf("a long answer cut off", { hasContinueButton: () => true }), "truncated");
  });

  test("prose that merely mentions a command is a plain answer", () => {
    assert.equal(kindOf('Use the "command" key to run things.'), "text");
  });

  test("looksLikeCommand covers signatures and raw argument keys only", () => {
    assert.equal(looksLikeCommand('{"command":"x"}'), true);
    assert.equal(looksLikeCommand('{"edits":[]}'), true);
    assert.equal(looksLikeCommand("hello"), false);
  });
});
