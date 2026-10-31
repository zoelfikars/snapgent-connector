import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ResponseWatcher } from "../src/application/response-watcher.js";
import { WatchState } from "../src/application/watch-state.js";
import { createWatchHarness } from "./support/watch-harness.js";

const wait = (h, base = 0) => new ResponseWatcher(h.deps).wait(base);
const CMD = '{"command":"read_file","params":{"path":"a.js"}}';

describe("ResponseWatcher: finishing a reply", () => {
  test("streams, stops, then returns the text once the DOM has settled", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "Hel" } })
      .at(300, { reply: "Hello wor" }).at(600, { reply: "Hello world", gen: false });
    const res = await wait(h);
    assert.deepEqual([res.kind, res.text], ["text", "Hello world"]);
    assert.ok(h.elapsed() >= 600 + 500, "waits for the 500ms settle after generation stops");
  });

  test("a command reply returns the parsed call", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: CMD } }).at(200, { gen: false });
    const res = await wait(h);
    assert.equal(res.kind, "tool");
    assert.equal(res.calls[0].tool, "read_file");
    assert.ok(h.diags.some(([e, d]) => e === "stopGoneToResp" && d.kind === "tool"));
  });

  test("a command block still being written is not parsed until it closes", async () => {
    const h = createWatchHarness({ initial: { gen: false, reply: '{"command":"read_file","params":{"path":"a' } })
      .at(1000, { reply: CMD });
    const res = await wait(h);
    assert.equal(res.kind, "tool");
    assert.ok(h.elapsed() >= 1000);
  });
});

describe("ResponseWatcher: stopping and giving up", () => {
  test("a user stop ends immediately", async () => {
    const h = createWatchHarness({ tabs: { stopped: true } });
    assert.deepEqual(await wait(h), { kind: "stopped" });
  });

  test("inactivity timeout when nothing is generating and the text never changes after starting", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "partial" } }).at(100, { gen: false });
    // text frozen + gen off => finalises as text, never times out
    assert.equal((await wait(h)).kind, "text");
  });

  test("a reply turn that never appears ends 'empty' after a minute of silence", async () => {
    const h = createWatchHarness({ initial: { reply: "", lastId: "t0", count: 0 } });
    const res = await wait(h);
    assert.equal(res.kind, "empty");
    assert.ok(h.elapsed() > 60000 && h.elapsed() < 62000);
    assert.ok(h.diags.some(([e, d]) => e === "empty.why" && d.branch === "preStart"));
  });

  test("a turn that starts but never produces content ends 'empty' after the warm-up window", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "" } }).at(100, { gen: false });
    const res = await wait(h);
    assert.equal(res.kind, "empty");
    assert.ok(h.diags.some(([e, d]) => e === "empty.why" && d.branch === "warmup"));
  });

  test("the inactivity timeout ends a wait that makes no progress", async () => {
    // Generating flag never set and reply never grows, but reliableCounts holds finalisation back
    // for the grace; with a short overall timeout the wait must give up as 'timeout'.
    const h = createWatchHarness({ initial: { reply: "old text", lastId: "t0" }, reliableCounts: true, timings: { RESPONSE_TIMEOUT_MS: 20000 } });
    h.sendToken.value = "t0"; // the last turn IS the previous one: no new reply yet
    assert.equal((await wait(h)).kind, "timeout");
  });
});

describe("ResponseWatcher: gates", () => {
  test("context-limit text on the page ends the wait", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "x", error: "context window exceeded" } });
    assert.deepEqual(await wait(h), { kind: "context_limit", detail: "context window exceeded" });
  });

  test("a short 'conversation too long' notice is recognised", async () => {
    const h = createWatchHarness({ initial: { gen: false, reply: "Too long", tooLong: true } });
    assert.equal((await wait(h)).kind, "too_long");
  });

  test("reasoning with no answer yet keeps waiting, and the answer then wins", async () => {
    const h = createWatchHarness({ initial: { gen: false, thinking: "hmm", reply: "" } }).at(5000, { reply: "Answer" });
    const res = await wait(h);
    assert.deepEqual([res.kind, res.text], ["text", "Answer"]);
    assert.ok(h.elapsed() >= 5000);
  });

  test("a halted reasoning-only turn is finalised instead of waited on", async () => {
    const h = createWatchHarness({ initial: { gen: false, thinking: "hmm", reply: "", halted: true } });
    const res = await wait(h);
    assert.equal(res.kind, "empty"); // nothing to say, but it does not wait 90s
    assert.ok(h.elapsed() < 5000);
  });

  test("a wedged generating flag with frozen text finalises after the stability window", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "Done answer" } });
    const res = await wait(h);
    assert.equal(res.kind, "text");
    assert.ok(h.elapsed() >= 9000 && h.elapsed() < 12000);
  });

  test("never finalises a still-open command while the site is generating, even if text pauses", async () => {
    const open = '{"command":"read_file","params":{"path":"';
    const h = createWatchHarness({ initial: { gen: true, reply: open } }).at(15000, { reply: CMD, gen: false });
    const res = await wait(h);
    assert.equal(res.kind, "tool");
    assert.ok(h.elapsed() >= 15000);
  });

  test("reliableCounts: a flag that flickers off before the new turn exists does not finalise the previous turn's text", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "old reply", lastId: "t0" }, reliableCounts: true })
      .at(200, { gen: false })
      .at(3000, { lastId: "t1", reply: "new reply", item: { id: "t1" } });
    h.sendToken.value = "t0";
    const res = await wait(h);
    assert.equal(res.text, "new reply");
    assert.ok(h.elapsed() >= 3000);
  });

  test("a hidden tab slides every deadline: a long park never trips the timeout", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "streaming" }, tabs: { hidden: true, parkMs: 3_600_000 }, timings: { RESPONSE_TIMEOUT_MS: 20000 } })
      .at(1_000, { gen: false });
    const res = await wait(h);
    assert.equal(res.kind, "text");
  });

  test("an unsettled command-shaped read is held, then released after the grace", async () => {
    const h = createWatchHarness({ initial: { reply: CMD, gen: false }, extras: { replyUnsettled: () => true } });
    const res = await wait(h);
    assert.equal(res.kind, "tool");
    assert.ok(h.elapsed() >= 8000);
  });

  test("a comparison (A/B) turn is resolved before the reply is read", async () => {
    let resolved = 0;
    const h = createWatchHarness({ initial: { reply: "pick me", gen: false }, extras: { isComparisonTurn: () => resolved === 0, resolveComparison: () => { resolved++; return true; } } });
    const res = await wait(h);
    assert.equal(resolved, 1);
    assert.equal(res.kind, "text");
    assert.ok(h.diags.some(([e]) => e === "carousel.resolved"));
  });

  test("a blank read at the moment of finalising falls back to the last good text", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "the full answer" } })
      .at(100, { gen: false }).at(300, { reply: "" });
    const res = await wait(h);
    assert.equal(res.text, "the full answer");
    assert.ok(h.diags.some(([e]) => e === "reply.blankReadFallback"));
  });
});

describe("ResponseWatcher: a page the adapter cannot read", () => {
  test("generating with no reply turn visible ends as 'unreadable' with layout diagnostics, not after minutes of silence", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "", item: null, lastId: null, count: 0 } });
    const res = await wait(h);
    assert.deepEqual(res, { kind: "unreadable" });
    assert.ok(h.elapsed() >= 15000 && h.elapsed() < 17000, `took ${h.elapsed()} ms`);
    assert.deepEqual(h.diags.find(([e]) => e === "layout.unreadable")[1], { layout: null, users: 1, assistants: 0 });
  });

  test("the reply turn appearing in time cancels the verdict", async () => {
    const h = createWatchHarness({ initial: { gen: true, reply: "", item: null, lastId: null, count: 0 } })
      .at(10000, { item: { id: "t1" }, lastId: "t1", count: 1, reply: "hello", gen: false });
    const res = await wait(h);
    assert.deepEqual([res.kind, res.text], ["text", "hello"]);
  });

  test("before the reply has started nothing is expected to be readable", async () => {
    const h = createWatchHarness({ initial: { gen: false, reply: "", item: null, lastId: null, count: 0 } });
    assert.equal((await wait(h)).kind, "empty"); // the 60 s silent-start path, not 'unreadable'
  });
});

describe("WatchState", () => {
  test("shift slides every running deadline but leaves unset ones at zero", () => {
    let t = 1000;
    const s = new WatchState(() => t);
    s.doneSince = 1500;
    s.shift(500);
    assert.deepEqual([s.lastActiveAt, s.lastChangeAt, s.doneSince, s.warmSince], [1500, 1500, 2000, 0]);
  });

  test("whitespace-only churn is not a text change; real growth is", () => {
    let t = 1000;
    const s = new WatchState(() => t);
    s.observeStability({ reply: "a  b" }, true);
    t = 2000;
    s.observeStability({ reply: "a b" }, true);
    assert.equal(s.lastChangeAt, 1000);
    t = 3000;
    s.observeStability({ reply: "a b c" }, true);
    assert.equal(s.lastChangeAt, 3000);
  });

  test("counts the generating flag flickering back on after it went off", () => {
    const s = new WatchState(() => 1000);
    s.started = true;
    s.observeStability({ reply: "x" }, true);
    s.observeStability({ reply: "x" }, false);
    s.observeStability({ reply: "x" }, true);
    assert.equal(s.genFlickers, 1);
  });

  test("shift also slides the unreadable clock", () => {
    const s = new WatchState(() => 1000);
    s.unreadableSince = 1200;
    s.shift(300);
    assert.equal(s.unreadableSince, 1500);
  });

  test("a new turn node forgets the previous turn's text", () => {
    const s = new WatchState(() => 1000);
    s.observeTurn({ item: "a", reply: "old" });
    s.observeTurn({ item: "b", reply: "" });
    assert.deepEqual([s.sawContent, s.lastGoodReply], [false, ""]);
  });
});
