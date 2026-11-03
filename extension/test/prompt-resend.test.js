import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SYS_MARKER } from "../src/domain/constants.js";
import { buildResendRider, countSinceLastMarker, fitsBudget, isResendDue } from "../src/domain/prompt/resend.js";
import { SysTally } from "../src/application/sys-tally.js";
import { PromptResender } from "../src/application/prompt-resender.js";

describe("resend rules", () => {
  test("due when either budget is spent; never when the feature is off", () => {
    assert.equal(isResendDue({ users: 5, results: 0 }, { everyUsers: 6 }), false);
    assert.equal(isResendDue({ users: 6, results: 0 }, { everyUsers: 6 }), true);
    assert.equal(isResendDue({ users: 0, results: 12 }, { everyUsers: 6 }), true);
    assert.equal(isResendDue({ users: 99, results: 99 }, { everyUsers: 0 }), false);
  });

  test("fitsBudget", () => {
    assert.equal(fitsBudget(10, 5, 15), true);
    assert.equal(fitsBudget(10, 6, 15), false);
    assert.equal(fitsBudget(1e9, 1e9), true);
  });

  test("the rider carries the marker and the prompt, and tells the model not to reply", () => {
    const rider = buildResendRider("PROMPT BODY");
    assert.ok(rider.endsWith("PROMPT BODY") && rider.includes("do not acknowledge this note"));
  });

  test("counting stops at the newest marker turn and separates typed turns from injected results", () => {
    const items = [
      { text: "old typed", isUser: true },
      { text: `${SYS_MARKER} prompt`, isUser: true },
      { text: "hello", isUser: true },
      { text: "assistant words", isUser: false },
      { text: "» read_file\nx", isUser: true },
      { text: "ERROR: nope", isUser: true },
    ];
    assert.deepEqual(countSinceLastMarker(items.length, (i) => items[i]), { users: 1, results: 2 });
    // lazy: the walk stops at the marker and never reads older turns
    const read = [];
    countSinceLastMarker(items.length, (i) => { read.push(i); return items[i]; });
    assert.deepEqual(read, [5, 4, 3, 2, 1]);
  });
});

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: async (k) => data[k], set: (k, v) => { data[k] = { ...v }; } };
}

describe("SysTally", () => {
  const make = (storage, key = "c1") => new SysTally({ storage, conversationKey: () => key, enabled: true });

  test("bump is synchronous and persisted per conversation", async () => {
    const storage = memoryStorage();
    const tally = make(storage);
    await tally.hydrate();
    tally.bump("results");
    tally.bump("results");
    assert.deepEqual(tally.counts(), { users: 0, results: 2 });
    assert.deepEqual(storage.data["zsSys:c1"], { users: 0, results: 2 });
  });

  test("hydrate takes the larger of stored and in-memory counts, so an early bump is not lost", async () => {
    const storage = memoryStorage({ "zsSys:c1": { users: 3, results: 1 } });
    const tally = make(storage);
    tally.bump("results");
    tally.bump("results");
    assert.deepEqual(await tally.hydrate(), { users: 3, results: 2 });
    assert.deepEqual(storage.data["zsSys:c1"], { users: 3, results: 2 }); // merged tally written back
  });

  test("nothing is written before the stored tally has been merged in", () => {
    const storage = memoryStorage({ "zsSys:c1": { users: 3, results: 1 } });
    make(storage).bump("results");
    assert.deepEqual(storage.data["zsSys:c1"], { users: 3, results: 1 });
  });

  test("switching conversation drops the old counts instead of leaking them into the new one", async () => {
    let key = "a";
    const storage = memoryStorage({ "zsSys:b": { users: 1, results: 0 } });
    const tally = new SysTally({ storage, conversationKey: () => key, enabled: true });
    await tally.hydrate();
    tally.bump("results");
    tally.bump("results");
    key = "b";
    tally.bump("users");
    assert.deepEqual(tally.counts(), { users: 1, results: 0 });
    assert.deepEqual(await tally.hydrate(), { users: 1, results: 0 }); // max(stored 1, carried 1)
    assert.deepEqual(storage.data["zsSys:a"], { users: 0, results: 2 }); // a's tally was not overwritten
  });

  test("a different conversation starts from its own stored tally", async () => {
    let key = "a";
    const storage = memoryStorage({ "zsSys:a": { users: 1, results: 1 }, "zsSys:b": { users: 7, results: 7 } });
    const tally = new SysTally({ storage, conversationKey: () => key, enabled: true });
    await tally.hydrate();
    key = "b";
    assert.deepEqual(await tally.hydrate(), { users: 7, results: 7 });
  });

  test("disabled tally never counts", () => {
    const tally = new SysTally({ storage: memoryStorage(), conversationKey: () => "c", enabled: false });
    tally.bump("users");
    assert.deepEqual(tally.counts(), { users: 0, results: 0 });
  });

  test("floorWith trusts what is visibly on screen when it is higher", () => {
    const tally = make(memoryStorage());
    tally.bump("users");
    assert.deepEqual(tally.floorWith({ users: 0, results: 4 }), { users: 1, results: 4 });
  });
});

describe("PromptResender", () => {
  function setup({ everyUsers = 6, dom = { users: 0, results: 0 }, cap } = {}) {
    const tally = new SysTally({ storage: memoryStorage(), conversationKey: () => "c", enabled: true });
    const diags = [];
    const sent = [];
    const resender = new PromptResender({
      tally, everyUsers, systemPrompt: () => "SYS", domCounts: () => dom,
      charBudget: cap === undefined ? undefined : () => cap, now: () => 42, onResent: (at) => sent.push(at), diag: (e, d) => diags.push([e, d]),
    });
    return { resender, tally, diags, sent };
  }

  test("nothing is attached before the budget is spent", () => {
    const { resender } = setup();
    assert.equal(resender.attach("result"), "result");
  });

  test("after 12 injected results the prompt rides on the next result and the budget resets", () => {
    const { resender, tally, sent, diags } = setup();
    for (let i = 0; i < 12; i++) resender.bump("results");
    const out = resender.attach("result");
    assert.ok(out.startsWith("result") && out.includes("re-statement") && out.endsWith("SYS"));
    assert.deepEqual(tally.counts(), { users: 0, results: 0 });
    assert.deepEqual(sent, [42]);
    assert.ok(diags.some(([e, d]) => e === "sys.resend" && d.via === "toolResult"));
  });

  test("a rider that does not fit is dropped, the result is never truncated, and it stays due", () => {
    const { resender, tally, diags } = setup({ cap: 50 });
    for (let i = 0; i < 12; i++) resender.bump("results");
    assert.equal(resender.attach("result"), "result");
    assert.equal(tally.counts().results, 12);
    assert.ok(diags.some(([e]) => e === "sys.resendDeferred"));
    assert.equal(resender.due(), true);
  });

  test("the on-screen floor can make it due on its own", () => {
    const { resender } = setup({ dom: { users: 6, results: 0 } });
    assert.equal(resender.due(), true);
  });

  test("claim() is how the fallback path spends the budget", () => {
    const { resender, tally, diags } = setup();
    for (let i = 0; i < 6; i++) resender.bump("users");
    const spent = resender.claim("ownTurn");
    assert.deepEqual(spent, { users: 6, results: 0 });
    assert.deepEqual(tally.counts(), { users: 0, results: 0 });
    assert.ok(diags.some(([e, d]) => e === "sys.resend" && d.via === "ownTurn"));
  });

  test("feature off (everyUsers 0): never due, bump does nothing", () => {
    const tally = new SysTally({ storage: memoryStorage(), conversationKey: () => "c", enabled: false });
    const resender = new PromptResender({ tally, everyUsers: 0, systemPrompt: () => "S", domCounts: () => ({ users: 99, results: 99 }) });
    resender.bump("results");
    assert.equal(resender.due(), false);
  });
});
