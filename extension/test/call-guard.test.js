import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { callWithGuards } from "../src/application/call-guard.js";
import { fakeTimers, flush } from "./support/fakes.js";

const never = () => new Promise(() => {});

describe("callWithGuards", () => {
  test("returns the call's result and leaves no timers behind", async () => {
    const timers = fakeTimers();
    const result = await callWithGuards(async () => ({ ok: true, text: "hi" }), { timeoutMs: 1000, isStopped: () => false, timers });
    assert.deepEqual(result, { ok: true, text: "hi" });
    assert.equal(timers.active, 0);
  });

  test("abandons the wait shortly after the user presses Stop", async () => {
    const timers = fakeTimers();
    let stopped = false;
    const pending = callWithGuards(never, { timeoutMs: 120000, isStopped: () => stopped, timers });
    timers.advance(1000);
    await flush();
    stopped = true;
    timers.advance(150);
    assert.deepEqual(await pending, { ok: false, kind: "stopped" });
    assert.equal(timers.active, 0);
  });

  test("gives a definitive timeout when the worker never answers", async () => {
    const timers = fakeTimers();
    const pending = callWithGuards(never, { timeoutMs: 1000, isStopped: () => false, timers });
    timers.advance(1000 + 29999);
    await flush();
    timers.advance(1);
    const result = await pending;
    assert.equal(result.kind, "timeout");
    assert.equal(timers.active, 0);
  });
});
