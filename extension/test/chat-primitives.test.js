import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { waitFor } from "../src/infrastructure/chat/wait.js";
import { StreamSampler } from "../src/infrastructure/chat/stream-sampler.js";
import { clickIfPresent } from "../src/infrastructure/chat/dom-helpers.js";

function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

describe("waitFor", () => {
  test("resolves true as soon as the predicate passes", async () => {
    const clock = fakeClock();
    let calls = 0;
    assert.equal(await waitFor(() => ++calls >= 3, 5000, clock), true);
    assert.equal(calls, 3);
  });

  test("resolves false after the timeout", async () => {
    const clock = fakeClock();
    assert.equal(await waitFor(() => false, 500, clock), false);
    assert.ok(clock.now() - 1000 >= 500);
  });
});

describe("StreamSampler", () => {
  test("is not generating before any output", () => {
    const clock = fakeClock();
    const s = new StreamSampler(clock);
    assert.equal(s.grewWithin(1000), false);
  });

  test("counts as generating while the reply grows, stops after it goes idle", () => {
    const clock = fakeClock();
    const s = new StreamSampler(clock);
    s.sample("turn-1", 10);
    clock.advance(500);
    s.sample("turn-1", 50);
    assert.equal(s.grewWithin(1000), true);
    clock.advance(1500);
    s.sample("turn-1", 50); // no growth
    assert.equal(s.grewWithin(1000), false);
  });

  test("a different reply element resets tracking", () => {
    const clock = fakeClock();
    const s = new StreamSampler(clock);
    s.sample("turn-1", 500);
    clock.advance(5000);
    s.sample("turn-2", 5);
    assert.equal(s.item, "turn-2");
    assert.equal(s.max, 5);
    assert.equal(s.grewWithin(1000), true);
  });

  test("a large shrink (regeneration) resets, a small wobble does not", () => {
    const clock = fakeClock();
    const s = new StreamSampler(clock);
    s.sample("t", 1000);
    s.sample("t", 900); // within tolerance
    assert.equal(s.max, 1000);
    s.sample("t", 100); // beyond tolerance
    assert.equal(s.max, 100);
  });

  test("minLen ignores placeholder-sized replies", () => {
    const clock = fakeClock();
    const strict = new StreamSampler({ ...clock, minLen: 2 });
    const loose = new StreamSampler({ ...clock, minLen: 1 });
    strict.sample("t", 1);
    loose.sample("t", 1);
    assert.equal(strict.grewWithin(1000), false);
    assert.equal(loose.grewWithin(1000), true);
  });
});

describe("clickIfPresent", () => {
  test("clicks when found, reports false when not or when click throws", () => {
    let clicked = 0;
    assert.equal(clickIfPresent(() => ({ click: () => clicked++ })), true);
    assert.equal(clicked, 1);
    assert.equal(clickIfPresent(() => null), false);
    assert.equal(clickIfPresent(() => ({ click() { throw new Error("detached"); } })), false);
  });
});

