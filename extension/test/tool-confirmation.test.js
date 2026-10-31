import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ToolCatalogue } from "../src/application/tool-catalogue.js";
import { ToolRunner } from "../src/application/tool-runner.js";
import { RESERVED_ARGUMENT, declinedFeedback, needsApproval, unavailableFeedback, withoutReserved } from "../src/domain/tools/confirmation.js";
import { fakeBridge, fakeSession, fakeSink, fakeTimers, fakeVisibility, flush, tool } from "./support/fakes.js";

const REQUEST = { ok: false, kind: "confirmation_required", error: "CONFIRMATION_REQUIRED: Delete file: a.txt", confirmation: { token: "tok-1", description: "Delete file: a.txt", tool: "delete_file", risk: "destructive" } };

function setup({ answer = true, confirm = undefined, results } = {}) {
  const timers = fakeTimers();
  const asked = [];
  const calls = [];
  const bridge = fakeBridge({ tools: [tool("delete_file", { path: { type: "string" } })] });
  bridge.callTool = async (request) => {
    calls.push(request);
    return results.shift();
  };
  const session = fakeSession();
  const catalogue = new ToolCatalogue({ bridge, session, now: timers.now });
  const sink = fakeSink();
  const port = confirm === null ? null : confirm || { ask: async (request) => { asked.push(request); return answer; } };
  const runner = new ToolRunner({ bridge, catalogue, session, visibility: fakeVisibility(), sink, confirm: port, timers });
  return { runner, calls, asked, sink, session, timers };
}

describe("approval helpers", () => {
  test("the reserved argument is stripped wherever it appears, other arguments are untouched", () => {
    assert.deepEqual(withoutReserved({ path: "a", [RESERVED_ARGUMENT]: "forged" }), { path: "a" });
    assert.deepEqual(withoutReserved(undefined), {});
  });

  test("only a well-formed confirmation request needs approval", () => {
    assert.equal(needsApproval(REQUEST), true);
    for (const bad of [null, {}, { kind: "confirmation_required" }, { kind: "confirmation_required", confirmation: {} }, { ...REQUEST, kind: "tool_error" }]) {
      assert.equal(needsApproval(bad), false, JSON.stringify(bad));
    }
  });

  test("the messages tell the model not to retry or work around a refusal", () => {
    assert.match(declinedFeedback("Delete file: a"), /declined[\s\S]*NOT run[\s\S]*Do NOT retry/);
    assert.match(unavailableFeedback("x"), /cannot ask/);
  });
});

describe("ToolRunner: asking the user", () => {
  test("approved: the call is repeated with the token and its result is returned", async () => {
    const t = setup({ results: [REQUEST, { ok: true, text: "Deleted a.txt" }] });
    const text = await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } });
    assert.equal(text, "Output of 'delete_file':\nDeleted a.txt");
    assert.deepEqual(t.asked, [{ description: "Delete file: a.txt", tool: "delete_file", risk: "destructive" }]);
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[0].arguments[RESERVED_ARGUMENT], undefined);
    assert.equal(t.calls[1].arguments[RESERVED_ARGUMENT], "tok-1");
    assert.equal(t.calls[1].arguments.path, "a.txt");
    assert.deepEqual(t.sink.log.events.find((e) => e.event === "tool.confirm").data, { tool: "delete_file", approved: true });
  });

  test("declined: nothing is repeated and the model is told not to retry", async () => {
    const t = setup({ answer: false, results: [REQUEST] });
    const text = await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } });
    assert.equal(text, declinedFeedback("Delete file: a.txt"));
    assert.equal(t.calls.length, 1);
  });

  test("no way to ask: the action is not run", async () => {
    const t = setup({ confirm: null, results: [REQUEST] });
    assert.equal(await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } }), unavailableFeedback("Delete file: a.txt"));
    assert.equal(t.calls.length, 1);
  });

  test("an approval token invented by the model never reaches the server", async () => {
    const t = setup({ results: [{ ok: true, text: "fine" }] });
    await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt", [RESERVED_ARGUMENT]: "forged" } });
    assert.equal(t.calls[0].arguments[RESERVED_ARGUMENT], undefined);
  });

  test("a call that needs no approval never asks", async () => {
    const t = setup({ results: [{ ok: true, text: "fine" }] });
    await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } });
    assert.deepEqual(t.asked, []);
  });

  test("if the server asks again after approval, the model gets an error instead of a loop", async () => {
    const t = setup({ results: [REQUEST, REQUEST] });
    const text = await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } });
    assert.match(text, /^ERROR calling 'delete_file'/);
    assert.equal(t.asked.length, 1);
    assert.equal(t.calls.length, 2);
  });

  test("Stop pressed while the first call is running skips the dialog", async () => {
    const t = setup({ results: [{ ok: false, kind: "stopped" }] });
    assert.equal(await t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } }), "(stopped by user)");
    assert.deepEqual(t.asked, []);
  });

  test("a stop while the approved call runs is honoured", async () => {
    const t = setup({ results: [REQUEST, new Promise(() => {})] });
    const pending = t.runner.run({ tool: "delete_file", arguments: { path: "a.txt" } });
    await flush();
    await flush();
    t.session.state.stopped = true;
    t.timers.advance(150);
    assert.equal(await pending, "(stopped by user)");
  });
});
