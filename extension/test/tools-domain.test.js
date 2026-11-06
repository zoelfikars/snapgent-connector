import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bareToolName, isKnownName } from "../src/domain/tools/names.js";
import { isolationError } from "../src/domain/tools/isolation.js";
import { toFeedback } from "../src/domain/tools/result-feedback.js";
import { renderCommandList, renderServerList } from "../src/domain/tools/virtual-commands.js";

describe("names", () => {
  test("bareToolName strips a server prefix", () => {
    assert.equal(bareToolName("snapgent/read_file"), "read_file");
    assert.equal(bareToolName("read_file"), "read_file");
    assert.equal(bareToolName(undefined), "");
  });

  test("isKnownName matches across prefixes and rejects empty input", () => {
    const names = new Set(["snapgent/read_file", "git_status"]);
    assert.equal(isKnownName(names, "read_file"), true);
    assert.equal(isKnownName(names, "other/git_status"), true);
    assert.equal(isKnownName(names, "nope"), false);
    assert.equal(isKnownName(new Set(), "read_file"), false);
    assert.equal(isKnownName(names, ""), false);
  });
});

describe("isolationError", () => {
  test("allows an enabled target with a bare or matching-prefix name", () => {
    assert.equal(isolationError({ name: "read_file", target: "snapgent", targetEnabled: true }), null);
    assert.equal(isolationError({ name: "snapgent/read_file", target: "snapgent", targetEnabled: true }), null);
  });
  test("refuses a disabled target and a foreign prefix", () => {
    assert.match(isolationError({ name: "x", target: "snapgent", targetEnabled: false }), /disabled/);
    assert.match(isolationError({ name: "evil/x", target: "snapgent", targetEnabled: true }), /Only the selected target/);
  });
});

describe("virtual commands", () => {
  test("renderCommandList: ordered refusals, then the scoped catalogue", () => {
    const tools = [{ name: "a", description: "A", inputSchema: {} }];
    const base = { name: "list_commands", target: "snapgent", enabled: true, tools };
    assert.match(renderCommandList({ ...base, asked: "other" }), /not available/);
    assert.match(renderCommandList({ ...base, enabled: false }), /disabled/);
    assert.match(renderCommandList({ ...base, tools: [] }), /No commands available/);
    assert.match(renderCommandList({ ...base, tools: [{ ...tools[0], server: "other" }] }), /has no commands available/);
    assert.match(renderCommandList(base), /snapgent commands \(1\):\n\na: A/);
  });

  test("renderServerList falls back to 'unknown' when the bridge reported nothing", () => {
    assert.match(renderServerList({ servers: [], target: "snapgent" }), /unknown \(bridge did not report server health\)/);
    assert.match(renderServerList({ servers: [{ id: "snapgent", alive: false }], target: "snapgent" }), /offline \(no tools\)/);
  });
});

describe("toFeedback", () => {
  const opts = { name: "read_file", supportsVision: false };

  test("success, empty success, and a parameter complaint disguised as success", () => {
    assert.equal(toFeedback({ ok: true, text: "x" }, opts).text, "» read_file\nx");
    assert.equal(toFeedback({ ok: true, text: "" }, opts).text, "» read_file\n(tool returned an empty result)");
    assert.match(toFeedback({ ok: true, text: "path is required" }, opts).text, /^ERROR calling 'read_file': path is required\./);
  });

  test("timeout message uses the configured seconds", () => {
    assert.match(toFeedback({ ok: false, kind: "timeout", error: "slow" }, { ...opts, timeoutSeconds: 5 }).text, /timed out after 5s/);
  });

  test("a cancellation from the terminal reads as one, not as an error to fix", () => {
    const feedback = toFeedback({ ok: false, kind: "cancelled", error: "The command was cancelled by the user before it finished." }, opts);
    assert.match(feedback.text, /⏹/);
    assert.match(feedback.text, /cancelled by the user/);
    assert.doesNotMatch(feedback.text, /^ERROR/);
  });

  test("no result at all means the bridge is offline", () => {
    assert.match(toFeedback(undefined, opts).text, /bridge is unreachable/);
  });
});
