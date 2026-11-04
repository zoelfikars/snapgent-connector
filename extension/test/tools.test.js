import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatToolForModel, formatCatalogue } from "../src/domain/tools/catalogue.js";
import { argSummary, feedbackIsError, runningLabel } from "../src/domain/tools/result-summary.js";
import { containsResult, resultHeader, startsWithResult, withoutResultHeader } from "../src/domain/tools/result-marker.js";

const readFile = {
  name: "read_file",
  description: "Read a file.\nSecond line is dropped.",
  inputSchema: { type: "object", properties: { path: { type: "string" }, tail: { type: "number" } }, required: ["path"] },
};

describe("catalogue", () => {
  test("optional params are marked with ?", () => {
    assert.equal(formatToolForModel(readFile), "read_file: Read a file.\n    path:string, tail?:number");
  });

  test("array-of-object params get their own line with the item shape", () => {
    const tool = {
      name: "apply_patch",
      description: "Patch",
      inputSchema: {
        properties: { edits: { type: "array", items: { type: "object", properties: { old_text: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_text"] } } },
        required: ["edits"],
      },
    };
    assert.match(formatToolForModel(tool), /edits: array \[each item: \{old_text:string, replace_all\?:boolean\}\]/);
  });

  test("tools are separated by a blank line", () => {
    assert.equal(formatCatalogue([readFile, readFile]).split("\n\n").length, 2);
  });
});

describe("result summary", () => {
  test("argSummary shows the first argument, truncated", () => {
    assert.equal(argSummary({ tool: "read_file", arguments: { path: "src/a.js" } }), "path: src/a.js");
    assert.ok(argSummary({ tool: "x", arguments: { a: "y".repeat(100) } }).endsWith("…"));
    assert.equal(argSummary({ tool: "x", arguments: {} }), "");
  });

  test("ERROR wrapper and in-body error lead-ins both count as failures", () => {
    assert.equal(feedbackIsError("ERROR: nope"), true);
    assert.equal(feedbackIsError("» x\nError executing code: boom"), true);
    assert.equal(feedbackIsError("» x\nFailed: 0"), false);
    assert.equal(feedbackIsError("» x\nall good"), false);
    assert.equal(feedbackIsError("Output of 'x':\nError executing code: boom"), true, "the older wording still counts");
  });

  test("runningLabel names the command and its place in a batch", () => {
    assert.equal(runningLabel({ tool: "read_files", arguments: { paths: ["a"] } }), "read_files · paths: a");
    assert.equal(runningLabel({ tool: "tree" }, { index: 1, total: 3 }), "2/3 · tree");
  });

  test("runningLabel shows a command with all its arguments, and long values are clipped only far out", () => {
    const run = { tool: "run_command", arguments: { command: "go", args: ["test", "./...", "-run", "Test Login"] } };
    assert.equal(runningLabel(run, { index: 0, total: 4 }), '1/4 · run_command · go test ./... -run "Test Login"');
    assert.equal(runningLabel({ tool: "read_files", arguments: { paths: ["a.go", "b.go"] } }), "read_files · paths: a.go, b.go");
    assert.ok(runningLabel({ tool: "x", arguments: { text: "y".repeat(1000) } }).length < 430);
  });
});

describe("result marker", () => {
  test("a result starts with the command's name behind a »", () => {
    assert.equal(resultHeader("tree"), "» tree");
    assert.equal(startsWithResult("» tree\nbody"), true);
    assert.equal(startsWithResult("  » tree"), true);
  });

  test("the older wording is still recognised", () => {
    assert.equal(startsWithResult("Output of 'tree':\nbody"), true);
    assert.equal(containsResult("intro\nOutput of 'tree':\nbody"), true);
  });

  test("a » in ordinary text is not a result", () => {
    for (const text of ["go » next", "I wrote » tree in the middle", "» ", "Output of x", ""]) assert.equal(startsWithResult(text), false, text);
    assert.equal(containsResult("see the » arrow and more words"), false);
  });

  test("a result inside a longer turn is found, and its header is stripped", () => {
    assert.equal(containsResult("intro\n» read_files\nbody"), true);
    assert.equal(withoutResultHeader("» read_files\nbody"), "body");
    assert.equal(withoutResultHeader("Output of 'x':\nbody"), "body");
    assert.equal(withoutResultHeader("plain"), "plain");
  });
});
