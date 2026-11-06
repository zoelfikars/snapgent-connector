import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SessionStarter } from "../src/application/session-starter.js";
import { checkStartPreconditions, handshakeUnavailable, probeSucceeded } from "../src/domain/agent/session-start.js";

const tool = (name) => ({ name });
const WORKSPACE = { title: "Workspace required", text: "Open a project folder in VS Code or Antigravity, then try again." };

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
    workspace: { refresh: async () => log.push("workspace") },
    startMessage: ({ commands, tree }) => `START|${commands}|${tree}`,
    chat: {
      submit: async (text) => { log.push(`submit:${text.slice(0, 12)}`); return `base${log.length}`; },
      next: async () => { log.push("next"); const r = queue.shift(); if (!r) throw new Error("no scripted reply"); return typeof r === "function" ? r(state) : r; },
    },
    runner: { run: async (call) => { log.push(`run:${call.tool}`); return state.handshakeFeedback ?? "» list_commands\nvscode commands (2):"; } },
    view: {
      toast: (t) => log.push(`toast:${t}`),
      banner: (l, title, text) => log.push(["banner", title, text]),
    },
    isStopped: () => state.stopped,
    diag: (e, d) => log.push(`diag:${e}`),
    ...over.deps,
  };
  return { starter: new SessionStarter(deps), log, state };
}

const ready = { kind: "text", text: "understood" };
const banners = (log) => log.filter((e) => Array.isArray(e) && e[0] === "banner");

describe("SessionStarter", () => {
  test("happy path: one message with everything in it, one answer -> started", async () => {
    const t = setup({ state: { responses: [ready] } });
    await t.starter.start();
    assert.deepEqual(t.log.filter((e) => typeof e === "string" && !e.startsWith("diag")), [
      "begin", "ensure:true", `probe:tree:{"path":"."}:5000`, "skills.load", "workspace", "run:list_commands",
      "submit:START|vscode", "next", "markStarted", "toast:Agent on.", "end:true",
    ]);
  });

  test("the model is never asked to fetch anything: the command list is run here and goes into the message", async () => {
    const t = setup({ state: { responses: [ready], handshakeFeedback: "» list_commands\nvscode commands (2):\n\nread_files" } });
    const submitted = [];
    t.starter._d.chat.submit = async (text) => { submitted.push(text); return "base"; };
    await t.starter.start();
    assert.equal(submitted.length, 1);
    assert.ok(submitted[0].startsWith("START|vscode commands (2):"), "the result's header line is not part of the message");
    assert.ok(!submitted[0].includes("»"));
  });

  test("the project tree goes into the message, cut to its share, when the start is given a budget", async () => {
    const t = setup({ state: { responses: [ready], probe: { ok: true, text: "root\n" + "x\n".repeat(30000) } }, deps: { initialContext: { limit: () => 10000 } } });
    const submitted = [];
    t.starter._d.chat.submit = async (text) => { submitted.push(text); return "base"; };
    await t.starter.start();
    assert.ok(submitted[0].length < 5000 && submitted[0].includes("omitted"));
  });

  test("a list that says the target is offline stops the start with a banner and sends nothing", async () => {
    const t = setup({ state: { handshakeFeedback: "» list_commands\nNo commands available - offline" } });
    await t.starter.start();
    assert.deepEqual(banners(t.log)[0].slice(1), ["VS Code unavailable", "Is the server online?"]);
    assert.ok(!t.log.some((e) => String(e).startsWith("submit")));
    assert.ok(!t.log.includes("markStarted"));
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

  test("superseded mid-way: stops quietly, never marks started, and end() is told it is not alive", async () => {
    const t = setup({ state: { responses: [() => { t.state.superseded = true; return ready; }] } });
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
    assert.deepEqual(banners(t.log)[0].slice(1), ["TestAI page not fully recognised", "Your message was sent but not detected as a user turn."]);
    assert.ok(t.log.includes("diag:layout.sentMissing"));
    assert.ok(t.log.includes("markStarted"));
  });

  test("a recognised sent message raises no warning", async () => {
    const layout = { sentMessageVisible: async () => true, describe: () => ({}) };
    const t = setup({ state: { responses: [ready] }, deps: { layout } });
    await t.starter.start();
    assert.equal(banners(t.log).length, 0);
  });

  test("non-workspace targets skip the workspace probe and skills", async () => {
    const t = setup({ state: { targetId: "other", tools: [tool("read_file")], responses: [ready] } });
    await t.starter.start();
    assert.ok(!t.log.some((e) => String(e).startsWith("probe")));
    assert.ok(!t.log.includes("skills.load"));
    assert.ok(t.log.includes("markStarted"));
  });
});

describe("choosing the folder of the chat", () => {
  const withChoice = (choice, responses = [ready]) => setup({ state: { responses }, deps: { workspace: { refresh: async () => {}, choose: async () => choice } } });

  test("the chosen folder is settled before anything is read from the workspace", async () => {
    const t = withChoice({ path: "/work/portofolio" });
    await t.starter.start();
    const events = t.log.filter((e) => typeof e === "string");
    assert.ok(events.includes("diag:start.workspace"));
    assert.ok(events.indexOf("diag:start.workspace") < events.findIndex((e) => e.startsWith("probe:")));
    assert.ok(events.includes("markStarted"));
  });

  test("closing the question cancels the start: nothing is sent and the chat stays blank", async () => {
    const t = withChoice({ cancelled: true });
    await t.starter.start();
    assert.ok(t.log.includes("toast:Start cancelled."));
    assert.equal(t.log.some((e) => typeof e === "string" && (e.startsWith("submit:") || e === "markStarted" || e.startsWith("probe:"))), false);
  });

  test("VS Code with no folder open is the workspace banner; a bridge that cannot be reached says so", async () => {
    const none = withChoice({ none: true });
    await none.starter.start();
    assert.deepEqual(banners(none.log), [["banner", WORKSPACE.title, WORKSPACE.text]]);
    const bad = withChoice({ error: "The bridge is not reachable." });
    await bad.starter.start();
    assert.deepEqual(banners(bad.log), [["banner", "Workspace", "The bridge is not reachable."]]);
  });
});

describe("project instruction files in the start message", () => {
  const found = (name, body) => ({ ok: true, text: `===== ${name} =====\n${body.map((line, i) => `${i + 1}: ${line}`).join("\n")}\n` });
  const notFound = (name) => ({ ok: true, text: `===== ${name} =====\nERROR: File not found: ${name}\n` });

  function withFiles(files) {
    const reads = [];
    const t = setup({
      state: { responses: [ready, ready] },
      deps: {
        contextFiles: async () => ["AGENTS.md", "CLAUDE.md", "GEMINI.md"],
        callTool: async (name, args) => {
          if (name !== "read_files") return { ok: true, text: "root" };
          const path = args.paths[0];
          reads.push(path);
          return files[path] ? found(path, files[path].split("\n")) : notFound(path);
        },
        startMessage: ({ commands, tree, context }) => `START|${commands}|${tree}|${context ? `${context.name}: ${context.text.trim()}` : "no context"}`,
      },
    });
    return { ...t, reads };
  }

  const submitTexts = async (t) => {
    const submitted = [];
    t.starter._d.chat.submit = async (text) => { submitted.push(text); return "base"; };
    return submitted;
  };

  test("the first file that exists is cleaned and goes into the message; nothing else is read", async () => {
    const t = withFiles({ "AGENTS.md": "# Project\nuse pnpm" });
    const submitted = await submitTexts(t);
    await t.starter.start();
    assert.deepEqual(t.reads, ["AGENTS.md"]);
    assert.ok(submitted[0].endsWith("|AGENTS.md: # Project\nuse pnpm"), submitted[0]);
    assert.ok(!submitted[0].includes("====="));
  });

  test("a missing first file falls through to the next one", async () => {
    const t = withFiles({ "CLAUDE.md": "claude rules" });
    const submitted = await submitTexts(t);
    await t.starter.start();
    assert.deepEqual(t.reads, ["AGENTS.md", "CLAUDE.md"]);
    assert.ok(submitted[0].endsWith("|CLAUDE.md: claude rules"));
  });

  test("none of the files exists: the start message carries no instructions", async () => {
    const t = withFiles({});
    const submitted = await submitTexts(t);
    await t.starter.start();
    assert.deepEqual(t.reads, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    assert.ok(submitted[0].endsWith("|no context"));
  });

  test("the instructions of the last chat are not reused when the next chat has none", async () => {
    let exists = true;
    const t = withFiles({});
    t.starter._d.callTool = async (name, args) => {
      if (name !== "read_files") return { ok: true, text: "root" };
      const path = args.paths[0];
      t.reads.push(path);
      return exists && path === "AGENTS.md" ? found(path, ["# Project"]) : notFound(path);
    };
    const submitted = await submitTexts(t);
    await t.starter.start();
    assert.ok(submitted[0].endsWith("|AGENTS.md: # Project"));
    exists = false;
    await t.starter.start();
    assert.ok(submitted[1].endsWith("|no context"));
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
  test("unavailable notes", () => {
    assert.equal(handshakeUnavailable("No commands available - offline"), true);
    assert.equal(handshakeUnavailable("vscode commands (2):"), false);
  });
});
