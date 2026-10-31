import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatToolForModel, formatCatalogue } from "../src/domain/tools/catalogue.js";
import { argSummary, outSummary, feedbackIsError, stripOutputPrefix } from "../src/domain/tools/result-summary.js";

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
    assert.equal(feedbackIsError("Output of 'x':\nError executing code: boom"), true);
    assert.equal(feedbackIsError("Output of 'x':\nFailed: 0"), false);
    assert.equal(feedbackIsError("Output of 'x':\nall good"), false);
  });

  test("outSummary summarises JSON shape instead of slicing it", () => {
    assert.equal(outSummary("Output of 'x':\n" + JSON.stringify({ files: [1, 2, 3] })), "3 files");
    assert.equal(outSummary("Output of 'x':\n" + JSON.stringify({ files: [1] })), "1 file");
    assert.equal(outSummary("Output of 'x':\n[1,2]"), "2 items");
  });

  test("outSummary reports line count for multi-line text", () => {
    assert.equal(outSummary("Output of 'x':\nfirst\nsecond"), "first · 2 lines");
  });

  test("stripOutputPrefix", () => {
    assert.equal(stripOutputPrefix("Output of 'x':\nbody"), "body");
  });
});
