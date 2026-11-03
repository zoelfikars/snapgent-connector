import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ToolReminder } from "../src/application/tool-reminder.js";
import { StallWatchdog } from "../src/application/stall-watchdog.js";
import { fakeTimers } from "./support/fakes.js";

describe("ToolReminder", () => {
  const ok = { isErr: false, tool: "read_file", hasCatalogue: true };

  test("fires every N successful calls and then starts over", () => {
    const r = new ToolReminder({ every: 3 });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => r.onResult(ok)), [false, false, true, false, false, true]);
  });

  test("errors, list_commands and a missing catalogue do not count", () => {
    const r = new ToolReminder({ every: 2 });
    assert.equal(r.onResult({ ...ok, isErr: true }), false);
    assert.equal(r.onResult({ ...ok, tool: "list_commands" }), false);
    assert.equal(r.onResult({ ...ok, hasCatalogue: false }), false);
    assert.equal(r.onResult(ok), false);
    assert.equal(r.onResult(ok), true);
  });

  test("reset starts a fresh cadence", () => {
    const r = new ToolReminder({ every: 2 });
    r.onResult(ok);
    r.reset();
    assert.equal(r.onResult(ok), false);
  });
});

describe("StallWatchdog", () => {
  function setup({ paused = false } = {}) {
    const timers = fakeTimers();
    const state = { sig: "a", paused, stalls: [] };
    const dog = new StallWatchdog({
      signature: () => state.sig, isPaused: () => state.paused, onStall: (s) => state.stalls.push(s),
      timers, now: timers.now, stallMs: 180000, pollMs: 5000,
    });
    return { dog, state, timers };
  }

  test("reports a stall only after the signature stops changing for the full window", () => {
    const { dog, state, timers } = setup();
    dog.start();
    timers.advance(170000);
    assert.equal(state.stalls.length, 0);
    timers.advance(20000);
    assert.deepEqual(state.stalls, ["a"]);
  });

  test("progress resets the clock", () => {
    const { dog, state, timers } = setup();
    dog.start();
    timers.advance(170000);
    state.sig = "b";
    timers.advance(170000);
    assert.equal(state.stalls.length, 0);
  });

  test("a legitimate pause (hidden tab, running tool) never counts", () => {
    const { dog, state, timers } = setup({ paused: true });
    dog.start();
    timers.advance(600000);
    assert.equal(state.stalls.length, 0);
  });

  test("does not fire again until another full window has passed; stop() clears the timer", () => {
    const { dog, state, timers } = setup();
    dog.start();
    timers.advance(190000);
    timers.advance(100000);
    assert.equal(state.stalls.length, 1);
    dog.stop();
    assert.equal(timers.active, 0);
  });
});

