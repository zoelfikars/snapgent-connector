import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeBarView } from "../src/ui/bar-view.js";
import { escapeHtml } from "../src/ui/html.js";

const base = {
  staleExtension: false, starting: false, started: false, running: false, parked: false, blankChat: true,
  bridge: { connected: true, servers: [{ id: "vscode", alive: true, tools: 28 }] }, bridgeOk: true,
  target: { id: "vscode", name: "VS Code" }, activeToolCount: 28, workspaceReady: true, workspaceProbePending: false, modeWarning: null,
};
const bar = (over = {}) => computeBarView({ ...base, ...over });

describe("bar view: before a session", () => {
  test("ready to start", () => {
    assert.deepEqual(bar(), { tone: "standby", message: "Ready.", spinner: false, label: "▶︎ Start", kind: "start", disabled: false, warn: false });
  });

  test("bridge not running: start it", () => {
    const v = bar({ bridge: { connected: false, servers: [] }, bridgeOk: false });
    assert.equal(v.message, "Start the <b>bridge</b>");
    assert.deepEqual([v.tone, v.disabled, v.warn, v.kind], ["warn", true, true, "start"]);
  });

  test("bridge running but waiting for the user to approve this extension", () => {
    const v = bar({ bridge: { connected: false, needsApproval: true, servers: [] }, bridgeOk: false });
    assert.equal(v.message, "Approve this extension in the <b>bridge terminal</b>");
    assert.deepEqual([v.disabled, v.warn], [true, true]);
    assert.equal(bar({ started: true, bridge: { connected: false, needsApproval: true, servers: [] } }).message, "<b>Active</b> · approve in the bridge terminal");
  });

  test("bridge up but VS Code has no folder open", () => {
    const v = bar({ bridgeOk: true, workspaceReady: false });
    assert.equal(v.message, "Open a <b>folder in VS Code</b>");
    assert.equal(v.disabled, true);
  });

  test("the server is alive but advertises no tools yet: still the folder message", () => {
    const v = bar({ bridgeOk: false, workspaceReady: false, bridge: { connected: true, servers: [{ id: "vscode", alive: true, tools: 0 }] } });
    assert.equal(v.message, "Open a <b>folder in VS Code</b>");
  });

  test("while the workspace is being probed", () => {
    assert.equal(bar({ workspaceReady: false, workspaceProbePending: true }).message, "Checking <b>VS Code workspace</b>…");
  });

  test("another target that is down is 'unavailable', and its name is escaped", () => {
    const v = bar({ target: { id: "x", name: "<script>alert(1)</script>" }, bridgeOk: false, workspaceReady: false });
    assert.equal(v.message, "<b>&lt;script&gt;alert(1)&lt;/script&gt; unavailable</b>");
  });

  test("another target that is up needs no workspace", () => {
    assert.equal(bar({ target: { id: "x", name: "X" }, workspaceReady: false }).kind, "start");
  });

  test("an existing conversation we did not start: informs only", () => {
    assert.deepEqual(bar({ blankChat: false }), { tone: "noagent", message: "No agent. Open a new chat.", spinner: false, label: "", kind: "", disabled: false, warn: false });
  });
});

describe("bar view: starting and started", () => {
  test("starting shows a spinner and a disabled button", () => {
    assert.deepEqual(bar({ starting: true }), { tone: "starting", message: "Starting…", spinner: true, label: "Starting…", kind: "starting", disabled: true, warn: false });
  });

  test("active shows tool count and target", () => {
    const v = bar({ started: true });
    assert.deepEqual([v.tone, v.message, v.kind], ["active", "<b>Active</b> · 28 tools · VS Code", ""]);
  });

  test("tool count falls back to the server's health count after a reload", () => {
    assert.equal(bar({ started: true, activeToolCount: 0 }).message, "<b>Active</b> · 28 tools · VS Code");
    assert.equal(bar({ started: true, activeToolCount: 0, bridge: { connected: true, servers: [] } }).message, "<b>Active</b> · VS Code");
  });

  test("active but the bridge dropped, or the target went offline", () => {
    assert.equal(bar({ started: true, bridge: { connected: false, servers: [] } }).message, "<b>Active</b> · start the bridge");
    const v = bar({ started: true, bridgeOk: false });
    assert.deepEqual([v.message, v.tone, v.warn], ["<b>Active</b> · VS Code offline", "warn", true]);
  });
});

describe("bar view: overrides", () => {
  test("a stale page can only say reload, whatever else is going on", () => {
    const v = bar({ staleExtension: true, started: true, starting: true, parked: true, running: true, modeWarning: "wrong mode" });
    assert.deepEqual([v.message, v.tone, v.kind], ["<b>Disconnected</b> · reload page", "warn", ""]);
  });

  test("a background tab with a live loop says paused, without the red warning", () => {
    const v = bar({ started: true, running: true, parked: true });
    assert.deepEqual([v.message, v.tone, v.warn], ["<b>Paused</b> · open this tab", "warn", false]);
    assert.equal(bar({ started: true, parked: true, running: false }).tone, "active", "parked flag alone, with nothing running, changes nothing");
  });

  test("an unsupported chat mode disables Start until the user switches back", () => {
    const v = bar({ modeWarning: "Use <b>Direct</b> mode" });
    assert.deepEqual([v.message, v.tone, v.warn, v.disabled, v.kind], ["Use <b>Direct</b> mode", "warn", true, true, "start"]);
  });

  test("the mode warning is ignored once a session exists", () => {
    assert.equal(bar({ started: true, modeWarning: "x" }).tone, "active");
    assert.equal(bar({ starting: true, modeWarning: "x" }).message, "Starting…");
  });
});

describe("escapeHtml", () => {
  test("escapes the five characters that matter, and coerces non-strings", () => {
    assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
    assert.equal(escapeHtml(42), "42");
  });
});

describe("computeBarView: a site that needs calibrating", () => {
  const base = { staleExtension: false, starting: false, started: false, running: false, parked: false, blankChat: true, bridge: { connected: true, servers: [] }, bridgeOk: true, target: { id: "vscode", name: "VS Code" }, activeToolCount: 0, workspaceReady: true, workspaceProbePending: false, modeWarning: "Cannot find the send button on this page. Re-calibrate it." };

  test("the only action is Calibrate, with the reason, whatever else is going on", () => {
    for (const blankChat of [true, false]) {
      const result = computeBarView({ ...base, blankChat, needsCalibration: true });
      assert.deepEqual([result.kind, result.label, result.disabled, result.warn], ["calibrate", "Calibrate", false, true]);
      assert.match(result.message, /send button/);
    }
  });

  test("a running session is not interrupted by it, and a site that does not need it is unchanged", () => {
    assert.notEqual(computeBarView({ ...base, started: true, needsCalibration: true }).kind, "calibrate");
    assert.equal(computeBarView({ ...base, needsCalibration: false, modeWarning: null }).kind, "start");
  });
});
