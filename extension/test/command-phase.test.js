import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { commandPhase, haltState, holdsRegenerateLook, shouldReown, REGEN_HOLD_MS } from "../src/ui/command-phase.js";

const NOW = 1_000_000;
const base = (over = {}) => ({
  stopped: false, isLast: true, generating: false, running: false, starting: false, resultBelow: false, executedBefore: false,
  resumeArmed: false, resumeArmedAt: 0, lastGenAt: NOW - 60_000, freshMs: 8000, now: NOW, dsml: false, errorBelow: false, ...over,
});
const outcome = (over) => { const r = commandPhase(base(over)); return [r.phase, r.detail]; };

describe("commandPhase", () => {
  test("a call still streaming is running", () => {
    assert.deepEqual(outcome({ generating: true }), ["run", ""]);
  });

  test("a call whose result is below is done", () => {
    assert.deepEqual(outcome({ resultBelow: true, isLast: false }), ["done", ""]);
  });

  test("a call that ran earlier (executed memory) is done even without a visible result", () => {
    assert.deepEqual(outcome({ executedBefore: true, isLast: false }), ["done", ""]);
  });

  test("the user stopped it: red 'stopped', even while the site is still settling", () => {
    assert.deepEqual(outcome({ stopped: true, generating: true, running: true }), ["err", "stopped"]);
  });

  test("a running loop keeps the in-flight call spinning until its result lands", () => {
    assert.deepEqual(outcome({ running: true, lastGenAt: NOW - 60_000 }), ["run", ""]);
    assert.deepEqual(outcome({ running: true, resultBelow: true }), ["done", ""]);
  });

  test("bootstrapping counts like a running loop", () => {
    assert.deepEqual(outcome({ starting: true }), ["run", ""]);
  });

  test("an old command on a revisited chat settles to done, not to a spinner, because its result is below", () => {
    assert.deepEqual(outcome({ running: true, isLast: false, resultBelow: true }), ["done", ""]);
  });

  test("just finished and not yet taken over: keeps spinning inside the watchdog's window", () => {
    assert.deepEqual(outcome({ lastGenAt: NOW - 3000 }), ["run", ""]);
  });

  test("the last command whose generation went stale is 'not run', not a false tick", () => {
    assert.deepEqual(outcome({ lastGenAt: NOW - 9000 }), ["idle", "not run"]);
  });

  test("the window is exactly the watchdog's: spinning at the limit, 'not run' just after", () => {
    assert.equal(commandPhase(base({ lastGenAt: NOW - 8000 })).phase, "run");
    assert.equal(commandPhase(base({ lastGenAt: NOW - 8001 })).phase, "idle");
  });

  test("an abandoned command with a newer turn below it shows neither a tick nor a spinner", () => {
    assert.deepEqual(outcome({ isLast: false, running: true }), ["idle", "not run"]);
  });

  test("regenerate grace keeps the fresh command running, then expires", () => {
    const armed = { resumeArmed: true, resumeArmedAt: NOW - 1000, lastGenAt: NOW - 60_000, executedBefore: true };
    assert.equal(commandPhase(base(armed)).phase, "run");
    assert.equal(commandPhase(base({ ...armed, resumeArmedAt: NOW - 2600 })).phase, "done");
  });

  test("a finished DSML turn is a red 'wrong format', but a still-streaming one spins", () => {
    assert.deepEqual(outcome({ dsml: true, resultBelow: true }), ["err", "wrong format"]);
    assert.deepEqual(outcome({ dsml: true, generating: true }), ["run", ""]);
  });

  test("an error result below turns a would-be green tick red and says so", () => {
    const result = commandPhase(base({ resultBelow: true, errorBelow: true, isLast: false }));
    assert.deepEqual([result.phase, result.detail, result.errorSettled], ["err", "error", true]);
  });

  test("an error result below does not change a running or stopped call", () => {
    assert.equal(commandPhase(base({ errorBelow: true, generating: true })).errorSettled, false);
    assert.deepEqual(outcome({ errorBelow: true, stopped: true }), ["err", "stopped"]);
  });
});

describe("haltState", () => {
  const facts = (over = {}) => ({ userStopped: false, isLast: true, generating: false, toolRunningOnThisTurn: false, marked: false, remembered: false, ...over });

  test("not halted unless one of the three records says so", () => {
    assert.deepEqual(haltState(facts()), { regenerating: false, stopped: false });
    for (const key of ["marked", "remembered"]) assert.equal(haltState(facts({ [key]: true })).stopped, true, key);
    assert.equal(haltState(facts({ userStopped: true })).stopped, true);
    assert.equal(haltState(facts({ userStopped: true, isLast: false })).stopped, false, "the latch only covers the last turn");
  });

  test("a turn generating again with no stop latch was regenerated: a stale halt no longer counts", () => {
    assert.deepEqual(haltState(facts({ generating: true, marked: true, remembered: true })), { regenerating: true, stopped: false });
    assert.equal(haltState(facts({ toolRunningOnThisTurn: true, marked: true })).regenerating, true);
  });

  test("a real stop that is still settling is never cleared, even though the site still looks busy", () => {
    assert.deepEqual(haltState(facts({ userStopped: true, generating: true })), { regenerating: false, stopped: true });
  });
});

describe("holdsRegenerateLook", () => {
  const facts = (over) => ({ baseLength: 200, armedAt: NOW, textLength: 200, now: NOW + 1000, ...over });
  test("holds while the old text is still shown", () => assert.equal(holdsRegenerateLook(facts()), true));
  test("releases once the content was replaced (clearly shorter)", () => {
    assert.equal(holdsRegenerateLook(facts({ textLength: 191 })), false);
    assert.equal(holdsRegenerateLook(facts({ textLength: 192 })), true, "within the slack it is still the old text");
  });
  test("releases after the safety window", () => {
    assert.equal(holdsRegenerateLook(facts({ now: NOW + REGEN_HOLD_MS })), true);
    assert.equal(holdsRegenerateLook(facts({ now: NOW + REGEN_HOLD_MS + 1 })), false);
  });
});

describe("shouldReown", () => {
  const facts = (over = {}) => ({ stopped: false, running: true, toolRunning: false, hasSettled: true, sameTurn: true, isLast: true, sameTool: true, ...over });
  test("only when every condition holds", () => {
    assert.equal(shouldReown(facts()), true);
    for (const key of Object.keys(facts())) {
      const flipped = { [key]: key === "stopped" || key === "toolRunning" ? true : false };
      assert.equal(shouldReown(facts(flipped)), false, key);
    }
  });
});
