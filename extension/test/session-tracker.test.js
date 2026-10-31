import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SessionTracker, textShowsSession } from "../src/application/session-tracker.js";

const MARK = "⟦ZS-SYS⟧";

async function tracker(saved) {
  const writes = [];
  const store = { get: async () => saved, set: (key, value) => writes.push([key, value]) };
  const t = new SessionTracker({ store });
  await t.ready;
  return { t, writes };
}
const facts = (over = {}) => ({ starting: false, startingKey: null, running: false, loopKey: null, injecting: false, started: false, key: "/c/1", chatEmpty: false, markerInDom: () => false, ...over });

describe("textShowsSession", () => {
  test("the marker, an injected result and a system note are session signals", () => {
    assert.equal(textShowsSession(`${MARK} hello`, MARK), true);
    assert.equal(textShowsSession("intro\nOutput of 'read_file':\nbody", MARK), true);
    assert.equal(textShowsSession("(System note: the reply was cut off.)", MARK), true);
  });
  test("a model merely showing the command format is not one", () => {
    assert.equal(textShowsSession('Use {"command":"read_file","arguments":{}} like this', MARK), false);
    assert.equal(textShowsSession("I read Output of 'x' somewhere", MARK), false);
  });
});

describe("SessionTracker: is this conversation a session", () => {
  test("a marker on the page starts it and is remembered under the conversation key", async () => {
    const { t, writes } = await tracker([]);
    assert.equal(t.decide(facts({ markerInDom: () => true })).started, true);
    assert.deepEqual(writes, [["zsStartedSessions", ["/c/1"]]]);
  });

  test("a remembered conversation is started on a cold load, with no marker in the DOM", async () => {
    const { t } = await tracker(["/c/1"]);
    assert.equal(t.decide(facts()).started, true);
  });

  test("on the same conversation it never downgrades when virtualization scrolled the marker away", async () => {
    const { t } = await tracker([]);
    t.decide(facts({ markerInDom: () => true }));
    assert.equal(t.decide(facts({ started: true })).started, undefined, "no change");
  });

  test("a different conversation is recomputed from scratch", async () => {
    const { t } = await tracker([]);
    t.decide(facts({ markerInDom: () => true }));
    assert.equal(t.decide(facts({ key: "/c/2", started: true })).started, false);
  });

  test("a transient (empty) key is never remembered and never sticky", async () => {
    const { t, writes } = await tracker([]);
    assert.equal(t.decide(facts({ key: "", markerInDom: () => true })).started, true);
    assert.deepEqual(writes, []);
    assert.equal(t.decide(facts({ key: "", started: true })).started, false, "an empty chat that follows is not started");
  });

  test("nothing changes while a bootstrap, an injection or a loop is in progress", async () => {
    const { t } = await tracker(["/c/1"]);
    for (const busy of [{ starting: true }, { injecting: true }, { running: true }]) {
      assert.equal(t.decide(facts(busy)).started, undefined, JSON.stringify(busy));
    }
  });

  test("the remembered set keeps only the newest 300 keys", async () => {
    const { t, writes } = await tracker(Array.from({ length: 300 }, (_, i) => `/old/${i}`));
    t.decide(facts({ key: "/new", markerInDom: () => true }));
    const saved = writes.at(-1)[1];
    assert.equal(saved.length, 300);
    assert.equal(saved.at(-1), "/new");
    assert.equal(saved[0], "/old/1");
  });

  test("ignores a stored value of the wrong shape and a failing store", async () => {
    assert.equal((await tracker("nope")).t.decide(facts()).started, undefined);
    const t = new SessionTracker({ store: { get: async () => { throw new Error("x"); }, set() {} } });
    await t.ready;
    assert.equal(t.decide(facts()).started, undefined);
  });

  test("the page is only scanned when the answer can matter", async () => {
    const { t } = await tracker([]);
    let scans = 0;
    t.decide(facts({ starting: true, markerInDom: () => { scans++; return false; } }));
    assert.equal(scans, 0);
  });
});

describe("SessionTracker: the user moved to another conversation", () => {
  test("a bootstrap pins its conversation once the chat has an id and content", async () => {
    const { t } = await tracker([]);
    assert.equal(t.decide(facts({ starting: true, chatEmpty: true })).startingKey, undefined, "empty chat: nothing to pin");
    assert.equal(t.decide(facts({ starting: true, key: "" })).startingKey, undefined, "no id yet");
    assert.equal(t.decide(facts({ starting: true })).startingKey, "/c/1");
  });

  test("an empty different chat abandons the bootstrap; a different chat with content does not", async () => {
    const { t } = await tracker([]);
    const away = t.decide(facts({ starting: true, startingKey: "/c/1", key: "/c/2", chatEmpty: true }));
    assert.deepEqual([away.abandonStart, away.startingKey], [true, null]);
    assert.equal(t.decide(facts({ starting: true, startingKey: "/c/1", key: "/c/2", chatEmpty: false })).abandonStart, false);
    assert.equal(t.decide(facts({ starting: true, startingKey: "/c/1", key: "/c/1", chatEmpty: true })).abandonStart, false);
  });

  test("a running loop pins and abandons the same way, without disturbing a normal session", async () => {
    const { t } = await tracker([]);
    assert.equal(t.decide(facts({ running: true })).loopKey, "/c/1");
    const away = t.decide(facts({ running: true, loopKey: "/c/1", key: "/c/2", chatEmpty: true }));
    assert.deepEqual([away.abandonLoop, away.loopKey], [true, null]);
    assert.equal(t.decide(facts({ running: true, loopKey: "/c/1", key: "/c/1" })).abandonLoop, false);
  });

  test("a bootstrap and a loop are judged independently", async () => {
    const { t } = await tracker([]);
    const both = t.decide(facts({ starting: true, running: true, startingKey: "/a", loopKey: "/b", key: "/c", chatEmpty: true }));
    assert.deepEqual([both.abandonStart, both.abandonLoop], [true, true]);
  });
});
