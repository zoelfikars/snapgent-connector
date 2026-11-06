import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ToolCatalogue } from "../src/application/tool-catalogue.js";
import { ToolRunner } from "../src/application/tool-runner.js";
import { FEEDBACK } from "../src/domain/prompt/feedback.js";
import { fakeBridge, fakeSession, fakeSink, fakeTimers, fakeVisibility, flush, tool } from "./support/fakes.js";

function setupRoot(root, over = {}) {
  const timers = fakeTimers();
  const bridge = fakeBridge({ tools: over.tools ?? [tool("read_file", { path: { type: "string" } })] });
  const sess = fakeSession(over.session);
  const catalogue = new ToolCatalogue({ bridge, session: sess, now: timers.now });
  const runner = new ToolRunner({ bridge, catalogue, session: sess, visibility: fakeVisibility(), sink: fakeSink(), timers, workspaceRoot: () => root });
  return { runner, bridge };
}

describe("ToolRunner: the folder the chat works in", () => {
  test("every VS Code call carries it, and a model-written one is dropped", async () => {
    const { runner, bridge } = setupRoot("/work/portofolio");
    await runner.run({ tool: "read_file", arguments: { path: "a", __snapgent_root: "/etc" } });
    assert.equal(bridge.calls[0].arguments.__snapgent_root, "/work/portofolio");
  });
  test("with VS Code closed (no commands offered) the model is told to ask the user, not given an empty list", async () => {
    const { runner, bridge } = setupRoot("/work/portofolio", { tools: [] });
    const text = await runner.run({ tool: "read_file", arguments: { path: "a" } });
    assert.equal(text, FEEDBACK.workspaceClosed("/work/portofolio"));
    assert.match(text, /open that folder in VS Code/);
    assert.equal(bridge.calls.length, 0);
  });
});

function setup({ tools = [tool("read_file", { path: { type: "string" } }), tool("git_status")], results, session, visibility } = {}) {
  const timers = fakeTimers();
  const bridge = fakeBridge({ tools, results });
  const sess = fakeSession(session);
  const catalogue = new ToolCatalogue({ bridge, session: sess, now: timers.now });
  const sink = fakeSink();
  const vis = fakeVisibility(visibility);
  const runner = new ToolRunner({ bridge, catalogue, session: sess, visibility: vis, sink, timers });
  return { runner, bridge, session: sess, sink, vis, timers, catalogue };
}

describe("ToolRunner.run — real tools", () => {
  test("a successful call returns 'Output of' and sends the right request to the selected server", async () => {
    const { runner, bridge } = setup({ results: { read_file: { ok: true, text: "file body" } } });
    const text = await runner.run({ tool: "read_file", arguments: { path: "a.js" } });
    assert.equal(text, "» read_file\nfile body");
    assert.deepEqual(bridge.calls, [{ name: "read_file", arguments: { path: "a.js", __snapgent_mode: "manual" }, timeout: 120000, server: "vscode" }]);
  });

  test("loads the catalogue lazily on the first call", async () => {
    const { runner, bridge } = setup();
    await runner.run({ tool: "git_status" });
    assert.equal(bridge.listCalls, 1);
  });

  test("a call without a name is a malformed-command error", async () => {
    const { runner } = setup();
    assert.equal(await runner.run({}), FEEDBACK.parseError("malformed"));
  });

  test("an unknown tool lists the valid names and never reaches the bridge", async () => {
    const { runner, bridge } = setup();
    const text = await runner.run({ tool: "rm_rf" });
    assert.equal(text, FEEDBACK.unknownTool("rm_rf", ["read_file", "git_status"]));
    assert.equal(bridge.calls.length, 0);
  });

  test("a disabled server refuses to run anything", async () => {
    const { runner, bridge } = setup({ session: { enabled: new Set() } });
    assert.match(await runner.run({ tool: "read_file" }), /disabled by the user/);
    assert.equal(bridge.calls.length, 0);
  });

  test("a prefix naming another server is refused", async () => {
    const { runner, bridge } = setup();
    assert.match(await runner.run({ tool: "other/read_file" }), /Only the selected target "vscode"/);
    assert.equal(bridge.calls.length, 0);
  });

  test("bridge errors become feedback for the model", async () => {
    const { runner } = setup({ results: { read_file: { ok: false, kind: "disconnected" }, git_status: { ok: false, error: "boom" } } });
    assert.equal(await runner.run({ tool: "read_file" }), FEEDBACK.bridgeOffline);
    assert.match(await runner.run({ tool: "git_status" }), /ERROR calling 'git_status': boom/);
  });

  test("a stale extension notifies the sink and tells the model to reload", async () => {
    const { runner, sink } = setup({ results: { read_file: { ok: false, kind: "stale-extension", error: "context invalidated" } } });
    assert.equal(await runner.run({ tool: "read_file" }), FEEDBACK.staleExtension);
    assert.deepEqual(sink.log.stale, [{ error: "context invalidated", name: "read_file" }]);
  });
});

describe("ToolRunner.run — images", () => {
  const image = { data: "AAAA", mimeType: "image/png" };

  test("without vision the image is refused and not stashed", async () => {
    const { runner, sink } = setup({ results: { read_file: { ok: true, text: "x", images: [image] } } });
    assert.match(await runner.run({ tool: "read_file" }), /cannot see images/);
    assert.equal(sink.log.images.length, 0);
  });

  test("with vision the images go to the sink and the text mentions the attachment", async () => {
    const { runner, sink } = setup({ session: { vision: true }, results: { read_file: { ok: true, text: "shot", images: [image] } } });
    assert.match(await runner.run({ tool: "read_file" }), /image is attached to THIS message/);
    assert.deepEqual(sink.log.images, [{ images: [image], name: "read_file" }]);
  });
});

describe("ToolRunner.run — virtual commands", () => {
  test("list_commands renders the selected server's catalogue without calling a tool", async () => {
    const { runner, bridge } = setup();
    const text = await runner.run({ tool: "list_commands" });
    assert.match(text, /^» list_commands\nvscode commands \(2\):/);
    assert.match(text, /read_file: read_file tool/);
    assert.equal(bridge.calls.length, 0);
  });

  test("asking for another server gets a generic refusal", async () => {
    const { runner } = setup();
    assert.match(await runner.run({ tool: "list_commands", arguments: { server: "secret" } }), /server "secret" is not available/);
  });

  test("list_mcp_servers reports only the selected, enabled server", async () => {
    const { runner } = setup({ session: { servers: [{ id: "vscode", alive: true, tools: 2 }, { id: "other", alive: true, tools: 9 }] } });
    const text = await runner.run({ tool: "list_mcp_servers" });
    assert.match(text, /- vscode: VS Code \(default target\) - 2 commands available/);
    assert.doesNotMatch(text, /other/);
  });
});

describe("ToolRunner.run — hidden tab and stop", () => {
  test("waits for the tab to become visible before running", async () => {
    const { runner, bridge, vis, sink } = setup({ visibility: { hidden: true } });
    await runner.run({ tool: "git_status" });
    assert.equal(vis.state.waits, 1);
    assert.equal(bridge.calls.length, 1);
    assert.ok(sink.log.events.some((e) => e.event === "tool.waitVisible"));
  });

  test("stopped while parked: the command is not run", async () => {
    const { runner, bridge } = setup({ visibility: { hidden: true, becomesVisible: false } });
    assert.match(await runner.run({ tool: "git_status" }), /not run - stopped by the user/);
    assert.equal(bridge.calls.length, 0);
  });

  test("Stop during a long call returns promptly with '(stopped by user)'", async () => {
    const { runner, session, timers } = setup({ results: { git_status: () => new Promise(() => {}) } });
    const pending = runner.run({ tool: "git_status" });
    await flush();
    session.state.stopped = true;
    timers.advance(150);
    assert.equal(await pending, "(stopped by user)");
  });
});

describe("ToolRunner — the terminal panel follows the job", () => {
  function setupTerminal({ tools = [tool("run_command", { command: { type: "string" } })], results, jobKey } = {}) {
    const timers = fakeTimers();
    const bridge = fakeBridge({ tools, results });
    const sess = fakeSession();
    const catalogue = new ToolCatalogue({ bridge, session: sess, now: timers.now });
    const calls = [];
    const sink = {
      images: () => {},
      staleExtension: () => {},
      diag: () => {},
      terminal: {
        begin: (job) => calls.push(["begin", job]),
        finish: (key, status) => calls.push(["finish", { key, status }]),
      },
    };
    const runner = new ToolRunner({ bridge, catalogue, session: sess, visibility: fakeVisibility(), sink, timers });
    return { runner, calls };
  }

  test("a call with a job key opens a tab named after the command, and settles it with the answer", async () => {
    const { runner, calls } = setupTerminal({ results: { run_command: { ok: true, text: "done" } } });
    await runner.run({ tool: "run_command", arguments: { command: "npm", args: ["test"] } }, { jobKey: "k1" });
    assert.deepEqual(calls[0], ["begin", { key: "k1", name: "run_command", label: "npm test" }]);
    assert.deepEqual(calls[1], ["finish", { key: "k1", status: "success" }]);
  });

  test("a call without a job key opens no tab", async () => {
    const { runner, calls } = setupTerminal();
    await runner.run({ tool: "run_command", arguments: { command: "ls" } });
    assert.deepEqual(calls, []);
  });

  test("a cancelled call settles the tab as stopped and reads as one", async () => {
    const { runner, calls } = setupTerminal({ results: { run_command: { ok: false, kind: "cancelled", error: "stopped by user" } } });
    const text = await runner.run({ tool: "run_command", arguments: { command: "sleep", args: ["99"] } }, { jobKey: "k1" });
    assert.match(text, /⏹/);
    assert.match(text, /stopped by user/);
    assert.deepEqual(calls[1], ["finish", { key: "k1", status: "stopped" }]);
  });
});
