import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ServerDirectory } from "../src/application/server-directory.js";

function memoryStore(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return { data, writes, get: async (key) => data[key], set: (key, value) => { data[key] = value; writes.push(key); } };
}

async function directory({ stored = {}, live = [] } = {}) {
  const store = memoryStore(stored);
  const state = { live, changes: 0 };
  const dir = new ServerDirectory({ store, liveServers: () => state.live, onChange: () => { state.changes++; } });
  await dir.ready;
  return { dir, store, state };
}

describe("ServerDirectory", () => {
  test("loads the toggles and the custom prompt, and announces the toggles once they are in", async () => {
    const { dir, state } = await directory({ stored: { zsMcpEnabled: { x: false }, zsCustomPrompt: "be brief" } });
    assert.deepEqual([dir.isEnabled("x"), dir.isEnabled("y"), dir.customPrompt, state.changes], [false, true, "be brief", 1]);
  });

  test("ignores stored values of the wrong shape", async () => {
    const { dir } = await directory({ stored: { zsMcpEnabled: [1], zsCustomMcpServers: "no", zsCustomPrompt: 7 } });
    assert.deepEqual([dir.isEnabled("x"), dir.servers(), dir.customPrompt], [true, [], ""]);
  });

  test("a store that throws leaves the defaults and does not reject", async () => {
    const dir = new ServerDirectory({ store: { get: async () => { throw new Error("boom"); }, set() {} }, liveServers: () => [] });
    await dir.ready;
    assert.equal(dir.isEnabled("x"), true);
  });

  test("setEnabled persists a new map and never mutates the old one", async () => {
    const { dir, store } = await directory();
    dir.setEnabled("x", false);
    dir.setEnabled("y", true);
    assert.deepEqual(store.data.zsMcpEnabled, { x: false, y: true });
    assert.equal(dir.isEnabled("x"), false);
  });

  test("lists the bridge's servers except the built-in one, using cached names", async () => {
    const { dir } = await directory({
      stored: { zsCustomMcpServers: [{ id: "git", name: "Git helper", command: "uvx" }] },
      live: [{ id: "vscode", alive: true }, { id: "git", alive: true, tools: [1] }],
    });
    assert.deepEqual(dir.servers(), [{ id: "git", name: "Git helper", command: "uvx", alive: true, tools: [1] }]);
  });

  test("a server the cache did not know is named by its id and remembered", async () => {
    const { dir, store } = await directory({ live: [{ id: "fresh", alive: false }] });
    assert.equal(dir.servers()[0].name, "fresh");
    assert.deepEqual(store.data.zsCustomMcpServers, [{ id: "fresh", name: "fresh" }]);
    const before = store.writes.length;
    dir.servers();
    assert.equal(store.writes.length, before, "nothing new to remember the second time");
  });

  test("a cached server the bridge has not reported yet stays listed, health unknown", async () => {
    const { dir } = await directory({ stored: { zsCustomMcpServers: [{ id: "gone", name: "Gone" }] } });
    assert.deepEqual(dir.servers(), [{ id: "gone", name: "Gone", alive: undefined, tools: undefined }]);
  });

  test("names: the built-in one, a known one, and an unknown id as itself", async () => {
    const { dir } = await directory({ stored: { zsCustomMcpServers: [{ id: "a", name: "Alpha" }] }, live: [{ id: "a" }] });
    assert.deepEqual(["vscode", "a", "zzz"].map((id) => dir.name(id)), ["Snapgent MCP", "Alpha", "zzz"]);
  });

  test("the dropdown offers only enabled servers but never loses the current target", async () => {
    const { dir } = await directory({ stored: { zsMcpEnabled: { a: false } }, live: [{ id: "a" }, { id: "b" }] });
    assert.deepEqual(dir.targetOptions("vscode").map((o) => o.id), ["vscode", "b"]);
    assert.deepEqual(dir.targetOptions("a").map((o) => o.id), ["vscode", "b", "a"]);
    assert.deepEqual(dir.allOptions().map((o) => o.id), ["vscode", "a", "b"], "the settings popup lists disabled ones too");
  });

  test("firstEnabled is what the page falls back to when the active target is switched off", async () => {
    const { dir } = await directory({ stored: { zsMcpEnabled: { vscode: false, a: false } }, live: [{ id: "a" }, { id: "b" }] });
    assert.equal(dir.firstEnabled().id, "b");
    dir.setEnabled("b", false);
    assert.equal(dir.firstEnabled(), null);
  });
});
