import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SessionStarter } from "../src/application/session-starter.js";
import { checkStartPreconditions, handshakeUnavailable, isHandshake, probeSucceeded } from "../src/domain/agent/session-start.js";

const tool = (name) => ({ name });
const WORKSPACE = { title: "VS Code workspace required", text: "Open a project folder in VS Code, then try again." };

function setup(over = {}) {
  const log = [];
  const state = { superseded: false, stopped: false, tools: [tool("tree"), tool("read_files")], empty: true, started: false, composerReady: true, probe: { ok: true }, responses: [], connected: true, serverAlive: true, targetId: "vscode", ...over.state };
  const queue = [...state.responses];
  const deps = {
    session: {
      canStart: () => !state.busy,
      begin: () => { log.push("begin"); return () => !state.superseded; },
      markStarted: () => log.push("markStarted"),
      end: (alive) => log.push(`end:${alive()}`),
    },
    page: { isEmpty: () => state.empty, isStarted: () => state.started, ensureComposerReady: async () => ({ ready: state.composerReady }), displayName: () => "TestAI" },
    target: { id: () => state.targetId, name: () => "VS Code", bridgeConnected: () => state.connected, serverAlive: () => state.serverAlive },
    catalogue: { ensure: async (force) => log.push(`ensure:${force}`), active: () => state.tools },
    callTool: async (name, args, timeout) => { log.push(`probe:${name}:${JSON.stringify(args)}:${timeout}`); return state.probe; },
    skills: { load: async () => log.push("skills.load") },
    systemPrompt: () => "PROMPT",
    chat: {
      submit: async (text) => { log.push(`submit:${text.slice(0, 12)}`); return `base${log.length}`; },
      next: async () => { log.push("next"); const r = queue.shift(); if (!r) throw new Error("no scripted reply"); return typeof r === "function" ? r(state) : r; },
    },
    runner: { run: async (call) => { log.push(`run:${call.tool}`); return state.handshakeFeedback ?? "Output of 'list_commands':\nvscode commands (2):"; } },
    view: {
      toast: (t) => log.push(`toast:${t}`),
      banner: (l, title, text) => log.push(["banner", title, text]),
      showStartingChip: () => log.push("chip:starting"),
      handshake: (item, phase, detail) => log.push(`handshake:${phase}:${detail}`),
    },
    isStopped: () => state.stopped,
    diag: (e, d) => log.push(`diag:${e}`),
    ...over.deps,
  };
  return { starter: new SessionStarter(deps), log, state };
}

const handshakeTurn = { kind: "tool", item: { id: "x" }, calls: [{ tool: "list_commands" }] };
const ready = { kind: "text", text: "ready" };
const banners = (log) => log.filter((e) => Array.isArray(e) && e[0] === "banner");

describe("SessionStarter", () => {
  test("happy path: prompt, handshake, ready -> started", async () => {
    const t = setup({ state: { responses: [handshakeTurn, ready] } });
    await t.starter.start();
    assert.deepEqual(t.log.filter((e) => typeof e === "string" && !e.startsWith("diag")), [
      "begin", "ensure:true", `probe:tree:{"path":"."}:5000`, "skills.load", "submit:PROMPT", "chip:starting", "next",
      "handshake:run:", "run:list_commands", "handshake:done:2 commands", "submit:Output of 'l", "next", "markStarted", "toast:Agent on.", "end:true",
    ]);
  });

  test("a model that skips the handshake still starts", async () => {
    const t = setup({ state: { responses: [ready] } });
    await t.starter.start();
    assert.ok(t.log.includes("markStarted"));
    assert.ok(!t.log.includes("run:list_commands"));
  });

  test("does nothing while another start/loop is running", async () => {
    const t = setup({ state: { busy: true } });
    await t.starter.start();
    assert.deepEqual(t.log, []);
  });

  test("an existing conversation is never bootstrapped", async () => {
    const t = setup({ state: { empty: false, started: false } });
    await t.starter.start();
    assert.deepEqual(t.log, ["toast:Use an empty chat."]);
  });

  test("a failed workspace probe asks for a folder and sends nothing", async () => {
    const t = setup({ state: { probe: { ok: false } } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), [WORKSPACE.title, WORKSPACE.text]);
    assert.ok(!t.log.some((e) => String(e).startsWith("submit")));
    assert.equal(t.log.at(-1), "end:true");
  });

  test("composer not ready reports the site's name", async () => {
    const t = setup({ state: { composerReady: false } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["TestAI mode not ready", "Try a new chat or reload."]);
  });

  test("no tools: 'tools unavailable'", async () => {
    const t = setup({ state: { tools: [], serverAlive: false } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["VS Code tools unavailable", "Is the server online?"]);
  });

  test("an unavailable target marks the handshake chip red", async () => {
    const t = setup({ state: { responses: [handshakeTurn, ready], handshakeFeedback: "Output of 'list_commands':\nNo commands available - offline" } });
    await t.starter.start();
    assert.ok(t.log.includes("handshake:err:VS Code unavailable"));
  });

  test("superseded mid-way: stops quietly, never marks started, and end() is told it is not alive", async () => {
    const t = setup({ state: { responses: [() => { t.state.superseded = true; return handshakeTurn; }] } });
    await t.starter.start();
    assert.ok(!t.log.includes("markStarted"));
    assert.equal(t.log.at(-1), "end:false");
    assert.equal(banners(t.log).length, 0);
  });

  test("a user stop during the bootstrap aborts without declaring ready", async () => {
    const t = setup({ state: { responses: [{ kind: "stopped" }] } });
    await t.starter.start();
    assert.ok(!t.log.includes("markStarted"));
    assert.ok(t.log.includes("diag:start.aborted"));
  });

  test("an exception becomes a 'Startup failed' banner and the session is still torn down", async () => {
    const t = setup({ deps: { catalogue: { ensure: async () => { throw new Error("bridge exploded"); }, active: () => [] } } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["Startup failed", "bridge exploded"]);
    assert.equal(t.log.at(-1), "end:true");
  });

  test("replies the adapter cannot read abort the start with an explanation, never 'ready'", async () => {
    const t = setup({ state: { responses: [{ kind: "unreadable" }] } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["Can't read TestAI's replies", "The site layout may have changed. Details are in the console ([zs-diag] layout.unreadable)."]);
    assert.ok(!t.log.includes("markStarted"));
    assert.equal(t.log.at(-1), "end:true");
  });

  test("a sent message that is not recognised as a user turn warns and logs the page, but the start continues", async () => {
    const layout = { sentMessageVisible: async () => false, describe: () => ({ chain: ["div[x]"] }) };
    const t = setup({ state: { responses: [ready] }, deps: { layout } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["TestAI page not fully recognised", "Your message was sent but not detected as a user turn, so hiding it may not work."]);
    assert.ok(t.log.includes("diag:layout.sentMissing"));
    assert.ok(t.log.includes("markStarted"));
  });

  test("a recognised sent message raises no warning", async () => {
    const layout = { sentMessageVisible: async () => true, describe: () => ({}) };
    const t = setup({ state: { responses: [ready] }, deps: { layout } });
    await t.starter.start();
    assert.equal(banners(t.log).length, 0);
  });

  test("non-vscode targets skip the workspace probe and skills", async () => {
    const t = setup({ state: { targetId: "other", responses: [ready] } });
    await t.starter.start();
    assert.ok(!t.log.some((e) => String(e).startsWith("probe")));
    assert.ok(!t.log.includes("skills.load"));
    assert.ok(t.log.includes("markStarted"));
  });
});

describe("start preconditions", () => {
  const base = { target: "vscode", targetName: "VS Code", bridgeConnected: true, serverAlive: true, toolNames: ["tree"] };
  test("ready when the probe tool exists", () => assert.equal(checkStartPreconditions(base), null));
  test("connected vscode server without list_dir means no workspace", () => assert.deepEqual(checkStartPreconditions({ ...base, toolNames: ["read_files"] }), WORKSPACE));
  test("no tools at all", () => assert.equal(checkStartPreconditions({ ...base, serverAlive: false, toolNames: [] }).title, "VS Code tools unavailable"));
  test("prefixed names still count", () => assert.equal(checkStartPreconditions({ ...base, toolNames: ["vscode/tree"] }), null));
  test("a non-vscode target needs no probe tool", () => assert.equal(checkStartPreconditions({ ...base, target: "x", toolNames: ["foo"] }), null));
  test("probe success", () => { assert.equal(probeSucceeded({ ok: true }), true); assert.equal(probeSucceeded(null), false); });
  test("handshake detection", () => {
    assert.equal(isHandshake({ kind: "tool", calls: [{ tool: "list_tools" }] }), true);
    assert.equal(isHandshake({ kind: "tool", calls: [{ tool: "list_commands" }, { tool: "x" }] }), false);
    assert.equal(isHandshake({ kind: "text" }), false);
  });
  test("unavailable notes", () => {
    assert.equal(handshakeUnavailable("No commands available - offline"), true);
    assert.equal(handshakeUnavailable("vscode commands (2):"), false);
  });
});
