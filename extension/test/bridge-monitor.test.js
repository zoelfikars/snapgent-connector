import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BridgeMonitor, PROBE_INTERVAL_MS } from "../src/application/bridge-monitor.js";

function monitor({ tools = [{ name: "snapgent__tree" }], listResult = { ok: true } } = {}) {
  const state = { now: 100_000, tools, calls: [], ensures: 0, changes: 0, logs: [], listResult, listError: null, ensureError: null };
  const mon = new BridgeMonitor({
    ensureTools: async () => { state.ensures++; if (state.ensureError) throw state.ensureError; },
    activeTools: () => state.tools,
    listRoot: async (name, timeout) => { state.calls.push([name, timeout]); if (state.listError) throw state.listError; return state.listResult; },
    isListTool: (name) => /tree$/.test(name),
    now: () => state.now,
    onChange: () => { state.changes++; },
    log: (...args) => state.logs.push(args),
  });
  return { mon, state };
}
const status = (over = {}) => ({ connected: true, servers: [{ id: "snapgent", alive: true, tools: 3 }], ...over });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BridgeMonitor: is the selected server usable", () => {
  test("connected, alive, with tools: usable", () => {
    const { mon } = monitor();
    mon.update(status(), "snapgent");
    assert.equal(mon.bridgeOk, true);
  });

  test("tools can come from the catalogue when the server has not counted them yet", () => {
    const { mon, state } = monitor();
    mon.update(status({ servers: [{ id: "snapgent", alive: true, tools: 0 }] }), "snapgent");
    assert.equal(mon.bridgeOk, true);
    state.tools = [];
    mon.update(status({ servers: [{ id: "snapgent", alive: true, tools: 0 }] }), "snapgent");
    assert.equal(mon.bridgeOk, false);
  });

  test("not usable when the bridge is down, the server is dead or the target is unknown", () => {
    const { mon } = monitor();
    for (const bad of [status({ connected: false }), status({ servers: [{ id: "snapgent", alive: false, tools: 3 }] }), status({ servers: [] }), status({ servers: undefined })]) {
      mon.update(bad, "snapgent");
      assert.equal(mon.bridgeOk, false);
    }
    mon.update(status(), "other");
    assert.equal(mon.bridgeOk, false);
  });

  test("reports a drop only when it was connected a moment ago", () => {
    const { mon } = monitor();
    assert.equal(mon.update(status({ connected: false }), "snapgent").lost, false, "never connected: nothing was lost");
    assert.equal(mon.update(status(), "snapgent").lost, false);
    assert.deepEqual(mon.update(status({ connected: false }), "snapgent"), { lost: true, connected: false });
    assert.equal(mon.update(status({ connected: false }), "snapgent").lost, false, "reported once");
    assert.deepEqual(mon.update(status(), "snapgent"), { lost: false, connected: true });
  });
});

describe("BridgeMonitor: is a workspace open", () => {
  test("lists the workspace root with the list tool and says ready when it works", async () => {
    const { mon, state } = monitor();
    mon.update(status(), "snapgent");
    assert.equal(mon.workspaceProbePending, true);
    await settle();
    assert.deepEqual(state.calls, [["snapgent__tree", 5000]]);
    assert.deepEqual([mon.workspaceReady, mon.workspaceProbePending, state.changes], [true, false, 1]);
  });

  test("a failing listing means no workspace", async () => {
    const { mon, state } = monitor({ listResult: { ok: false } });
    mon.update(status(), "snapgent");
    await settle();
    assert.deepEqual([mon.workspaceReady, state.changes], [false, 1]);
  });

  test("no list tool, or a throwing call, means no workspace and is logged, never thrown", async () => {
    const none = monitor({ tools: [{ name: "snapgent__read_file" }] });
    none.mon.update(status(), "snapgent");
    await settle();
    assert.equal(none.mon.workspaceReady, false);
    assert.equal(none.state.calls.length, 0);

    const broken = monitor();
    broken.state.listError = new Error("boom");
    broken.mon.update(status(), "snapgent");
    await settle();
    assert.deepEqual([broken.mon.workspaceReady, broken.mon.workspaceProbePending, broken.state.logs.length], [false, false, 1]);
  });

  test("never two probes at once, and not more often than the interval", async () => {
    const { mon, state } = monitor();
    mon.update(status(), "snapgent");
    mon.update(status(), "snapgent");
    await settle();
    assert.equal(state.ensures, 1, "one in flight");
    state.now += PROBE_INTERVAL_MS - 1;
    mon.update(status(), "snapgent");
    await settle();
    assert.equal(state.ensures, 1, "too soon");
    state.now += 1;
    mon.update(status(), "snapgent");
    await settle();
    assert.equal(state.ensures, 2);
  });

  test("only the VS Code target has a workspace, and losing the server resets it", async () => {
    const { mon, state } = monitor();
    mon.update(status({ servers: [{ id: "git", alive: true, tools: 2 }] }), "git");
    await settle();
    assert.equal(state.ensures, 0, "another server is not probed");
    mon.update(status(), "snapgent");
    await settle();
    assert.equal(mon.workspaceReady, true);
    mon.update(status({ servers: [{ id: "snapgent", alive: false, tools: 3 }] }), "snapgent");
    assert.equal(mon.workspaceReady, false);
  });
});
