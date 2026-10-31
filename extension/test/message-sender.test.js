import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MessageSender, resolveRetryLimit } from "../src/application/message-sender.js";

function setup({ behaviour = "clears", hidden = false, stopped = false, retryLimit, streamGrows = false, images } = {}) {
  const log = [];
  const state = { users: 3, assistants: 3, editor: "", stopped, hidden, sends: 0, streamLen: 100, generating: false, item: { id: 1 } };
  const page = {
    lastAssistant: () => state.item,
    streamLen: () => state.streamLen,
    isGenerating: () => state.generating,
    isBusyNow: () => false,
    assistantCount: () => state.assistants,
    userCount: () => state.users,
    editorText: () => state.editor,
    async typeAndSend(text) {
      state.sends++;
      log.push(["typeAndSend", text]);
      if (behaviour === "clears") state.editor = "";
      else if (behaviour === "lands-late-on-2") { if (state.sends === 2) state.users++; state.editor = "stuck"; }
      else state.editor = text; // never accepted
    },
  };
  const clock = {
    // advance the page's idea of time by letting the stream grow during the settle yield
    sleep: async (ms) => { log.push(["sleep", ms]); if (streamGrows) { state.streamLen += 50; state.generating = true; } },
    waitFor: async (predicate, timeout) => { log.push(["waitFor", timeout]); const ok = predicate(); if (!ok) state.generating = false; return ok; },
  };
  const effects = ["begin", "armPrehide", "rearmPrehide", "end"].reduce((o, k) => ({ ...o, [k]: (...a) => log.push([k, ...a]) }), {});
  const visibility = { isHidden: () => state.hidden, waitUntilVisible: async () => { log.push(["waitUntilVisible"]); state.hidden = false; return true; } };
  const sender = new MessageSender({
    page, visibility, effects, clock, retryLimit,
    isStopped: () => state.stopped,
    beforeSend: async () => log.push(["jitter"]),
    notify: { banner: (...a) => log.push(["banner", ...a]) },
    diag: (e, d) => log.push(["diag", e, d]),
  });
  return { sender, state, log, names: () => log.map((e) => e[0] === "diag" ? `diag:${e[1]}` : e[0]), run: () => sender.submit("hello", images) };
}

describe("MessageSender", () => {
  test("returns the assistant count from BEFORE the send and wraps the send in begin/end", async () => {
    const t = setup();
    assert.equal(await t.run(), 3);
    assert.equal(t.names()[0], "begin");
    assert.equal(t.names().at(-1), "end");
  });

  test("arms the pre-hide with the user count, and re-arms after typing", async () => {
    const t = setup();
    await t.run();
    assert.deepEqual(t.log.find((e) => e[0] === "armPrehide"), ["armPrehide", 3]);
    assert.ok(t.names().indexOf("typeAndSend") < t.names().indexOf("rearmPrehide"));
  });

  test("one attempt is enough when the composer clears", async () => {
    const t = setup();
    await t.run();
    assert.equal(t.state.sends, 1);
    assert.ok(t.names().includes("diag:send.cleared"));
    assert.ok(!t.names().includes("banner"));
  });

  test("retries when the composer does not clear, up to the limit, then tells the user", async () => {
    const t = setup({ behaviour: "never", retryLimit: 3 });
    await t.run();
    assert.equal(t.state.sends, 3);
    assert.deepEqual(t.log.find((e) => e[0] === "banner"), ["banner", "warn", "Message could not be sent", 'Send "continue" to resume.']);
    assert.ok(t.names().includes("diag:send.failed"));
  });

  test("stops retrying as soon as a new turn shows up, even though the composer never cleared", async () => {
    const t = setup({ behaviour: "lands-late-on-2" });
    await t.run();
    assert.equal(t.state.sends, 2);
    assert.ok(!t.names().includes("banner"));
  });

  test("never types while the tab is hidden", async () => {
    const t = setup({ hidden: true });
    await t.run();
    assert.ok(t.names().indexOf("waitUntilVisible") < t.names().indexOf("typeAndSend"));
  });

  test("a stop before sending sends nothing and raises no failure banner", async () => {
    const t = setup({ stopped: true });
    await t.run();
    assert.equal(t.state.sends, 0);
    assert.ok(!t.names().includes("banner"));
    assert.equal(t.names().at(-1), "end");
  });

  test("waits for a still-streaming previous reply before sending, but not for a quiet one", async () => {
    const quiet = setup();
    await quiet.run();
    assert.equal(quiet.log.filter((e) => e[0] === "waitFor" && e[1] === 4000).length, 0);
    const busy = setup({ streamGrows: true });
    await busy.run();
    assert.equal(busy.log.filter((e) => e[0] === "waitFor" && e[1] === 4000).length, 1);
  });

  test("end() runs even when typing throws", async () => {
    const t = setup();
    t.sender._d.page.typeAndSend = async () => { throw new Error("composer gone"); };
    await assert.rejects(t.run(), /composer gone/);
    assert.equal(t.names().at(-1), "end");
  });

  test("retry limit: positive integers only, default 4", () => {
    assert.deepEqual([undefined, 0, -1, 2.5, "3", 2].map(resolveRetryLimit), [4, 4, 4, 4, 4, 2]);
  });
});
