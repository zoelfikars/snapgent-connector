import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { controlFace, planReplay } from "../src/domain/agent/agent-mode.js";
import { computeBarView } from "../src/ui/bar-view.js";
import { createAgentMode } from "../src/page/agent-mode.js";
import { createReplay } from "../src/page/replay.js";

const COMMAND = ["```json", '{"command":"tree","params":{}}', "```"].join("\n");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("controlFace", () => {
  const live = { discuss: false, busy: false, started: true, starting: false, stale: false };

  test("a live, idle session offers Play", () => assert.equal(controlFace(live), "play"));
  test("a busy agent shows Stop", () => assert.equal(controlFace({ ...live, busy: true }), "stop"));
  test("Discussion mode offers neither", () => assert.equal(controlFace({ ...live, discuss: true }), "off"));

  test("nothing to play before a session, while starting, or on a stale page", () => {
    for (const over of [{ started: false }, { starting: true }, { stale: true }]) assert.equal(controlFace({ ...live, ...over }), "off");
  });
});

describe("planReplay", () => {
  const text = `Let me look.\n${COMMAND}`;

  test("a command that has not run is run", () => assert.deepEqual(planReplay({ text, generating: false, alreadyRan: false }), { type: "run" }));
  test("a command that already ran is skipped, never run twice", () => assert.equal(planReplay({ text, generating: false, alreadyRan: true }).type, "already-ran"));
  test("plain text holds nothing to run", () => assert.equal(planReplay({ text: "Just talking.", generating: false, alreadyRan: false }).type, "none"));
  test("nothing is read while the AI is still writing", () => assert.equal(planReplay({ text, generating: true, alreadyRan: false }).type, "generating"));
});

describe("bar view: Discussion mode", () => {
  const base = {
    staleExtension: false, starting: false, started: true, running: false, parked: false, blankChat: false,
    bridge: { connected: true, servers: [{ id: "snapgent", alive: true, tools: 28 }] }, bridgeOk: true,
    target: { id: "snapgent", name: "VS Code" }, activeToolCount: 28, workspaceReady: true, workspaceProbePending: false, modeWarning: null,
  };

  test("a started session in Discussion says the agent is off", () => {
    const view = computeBarView({ ...base, discuss: true });
    assert.deepEqual([view.tone, view.message, view.kind], ["standby", "<b>Discussion</b> · agent off", ""]);
  });

  test("without a session the flag changes nothing", () => {
    assert.equal(computeBarView({ ...base, started: false, blankChat: true, discuss: true }).kind, "start");
  });

  test("with the agent on the bar is as before", () => assert.equal(computeBarView({ ...base, discuss: false }).tone, "active"));
});

function modeWorld({ saved, key = "chat-1", flags = {} } = {}) {
  let stored = saved;
  const writes = [];
  const world = { key, stops: 0, changes: 0 };
  const state = { discuss: false, running: false, toolRunning: false, userStopped: false, ...flags };
  const storage = { get: async () => stored, set: (_key, value) => { stored = value; writes.push(value); }, watch: () => {} };
  const mode = createAgentMode({
    state, provider: { conversationKey: () => world.key }, storage,
    onStop: () => { world.stops++; }, onChange: () => { world.changes++; }, diag: () => {},
  });
  return { state, world, mode, writes };
}

describe("agent mode: the switch", () => {
  test("is remembered per conversation", async () => {
    const w = modeWorld();
    await tick();
    assert.equal(w.mode.set(true), true);
    assert.equal(w.state.discuss, true);
    assert.deepEqual(w.writes.at(-1), { "chat-1": true });
    w.world.key = "chat-2";
    w.mode.sync();
    assert.equal(w.state.discuss, false, "another chat starts with the agent on");
    w.world.key = "chat-1";
    w.mode.sync();
    assert.equal(w.state.discuss, true);
  });

  test("survives a reload: it is read back from storage", async () => {
    const w = modeWorld({ saved: { "chat-1": true } });
    assert.equal(w.state.discuss, false, "not before the store has been read");
    await tick();
    assert.equal(w.state.discuss, true);
  });

  test("a damaged store is ignored", async () => {
    const w = modeWorld({ saved: "junk" });
    await tick();
    assert.equal(w.state.discuss, false);
  });

  test("turning it on ends a running loop; when idle there is nothing to end", async () => {
    const busy = modeWorld({ flags: { running: true } });
    await tick();
    busy.mode.set(true);
    assert.equal(busy.world.stops, 1);
    const idle = modeWorld();
    await tick();
    idle.mode.set(true);
    assert.equal(idle.world.stops, 0);
  });

  test("back to Agent does not act by itself: the stop latch is set", async () => {
    const w = modeWorld();
    await tick();
    w.mode.set(true);
    w.state.userStopped = false; // a message typed during Discussion clears it
    w.mode.set(false);
    assert.equal(w.state.discuss, false);
    assert.equal(w.state.userStopped, true);
  });

  test("a chat without an id cannot keep the choice", async () => {
    const w = modeWorld({ key: "" });
    await tick();
    assert.equal(w.mode.set(true), false);
    assert.equal(w.state.discuss, false);
  });
});

function replayWorld({ text = `Let me look.\n${COMMAND}`, tail = [], generating = false, ran = false, flags = {} } = {}) {
  const reply = { dataset: { zResume: "1", zResumeLen: "9", zloop: "1" }, text };
  const items = [reply, ...tail];
  const toasts = [];
  const runs = [];
  const state = { started: true, discuss: false, running: false, starting: false, injecting: false, stopping: false, userStopped: true, sendToken: undefined, ...flags };
  const { play } = createReplay({
    state,
    provider: { lastAssistant: () => reply, allItems: () => items, isUserItem: (item) => !!item.user, itemText: (item) => item.text, isGenerating: () => generating, assistantCount: () => 3 },
    executed: { has: () => ran },
    loop: { run: (base) => runs.push(base) },
    bar: { toast: (message) => toasts.push(message) },
    diag: () => {},
  });
  return { play, reply, state, toasts, runs };
}

describe("Play: read the last reply again", () => {
  test("runs a command that has not run, as fresh intent, and clears the old markers", () => {
    const w = replayWorld();
    w.play();
    assert.deepEqual(w.runs, [2]);
    assert.equal(w.state.userStopped, false);
    assert.equal(w.state.sendToken, null);
    assert.deepEqual(w.reply.dataset, {});
  });

  test("a command the turn memory has seen is not run again", () => {
    const w = replayWorld({ ran: true });
    w.play();
    assert.deepEqual([w.runs.length, w.toasts], [0, ["Already ran · nothing new to run"]]);
  });

  test("a command followed by our result turn is not run again", () => {
    const w = replayWorld({ tail: [{ user: true, text: "» tree\nsrc/\n" }] });
    w.play();
    assert.equal(w.runs.length, 0);
    assert.equal(w.toasts.length, 1);
  });

  test("a reply without a command says so", () => {
    const w = replayWorld({ text: "Just talking." });
    w.play();
    assert.deepEqual([w.runs.length, w.toasts], [0, ["No command in the last reply"]]);
  });

  test("nothing happens while the AI is writing", () => {
    const w = replayWorld({ generating: true });
    w.play();
    assert.equal(w.runs.length, 0);
    assert.equal(w.toasts.length, 1);
  });

  test("in Discussion, while busy, or without a session Play does nothing at all", () => {
    for (const flags of [{ discuss: true }, { running: true }, { stopping: true }, { starting: true }, { started: false }]) {
      const w = replayWorld({ flags });
      w.play();
      assert.deepEqual([w.runs.length, w.toasts.length], [0, 0], JSON.stringify(flags));
    }
  });
});
