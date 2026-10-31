import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ToolCatalogue } from "../src/application/tool-catalogue.js";
import { fakeBridge, fakeSession, tool } from "./support/fakes.js";

function setup({ tools = [tool("read_file"), tool("git_status")], enabled } = {}) {
  let clock = 0;
  const bridge = fakeBridge({ tools });
  const session = fakeSession(enabled ? { enabled } : {});
  const catalogue = new ToolCatalogue({ bridge, session, now: () => clock, ttlMs: 30000 });
  return { bridge, session, catalogue, tick: (ms) => { clock += ms; } };
}

describe("ToolCatalogue", () => {
  test("starts empty and loads from the bridge", async () => {
    const { catalogue } = setup();
    assert.equal(catalogue.hasAny(), false);
    await catalogue.ensure();
    assert.equal(catalogue.hasAny(), true);
    assert.deepEqual([...catalogue.names()], ["read_file", "git_status"]);
  });

  test("does not hit the bridge twice inside the TTL, but does after it or when forced", async () => {
    const { bridge, catalogue, tick } = setup();
    await catalogue.ensure();
    tick(1000);
    await catalogue.ensure();
    assert.equal(bridge.listCalls, 1);
    await catalogue.ensure(true);
    assert.equal(bridge.listCalls, 2);
    tick(31000);
    await catalogue.ensure();
    assert.equal(bridge.listCalls, 3);
  });

  test("an empty refresh keeps the previous catalogue", async () => {
    const { bridge, catalogue, tick } = setup();
    await catalogue.ensure();
    bridge.tools = [];
    tick(31000);
    await catalogue.ensure();
    assert.equal(catalogue.all.length, 2);
  });

  test("only the selected, enabled server's tools are active", async () => {
    const { catalogue, session } = setup({
      tools: [tool("a", {}, "vscode"), tool("b", {}, "other"), tool("legacy")],
      enabled: new Set(["vscode", "other"]),
    });
    await catalogue.ensure();
    assert.deepEqual([...catalogue.names()].sort(), ["a", "legacy"]); // untagged tool belongs to vscode
    session.state.target = "other";
    assert.deepEqual([...catalogue.names()], ["b"]);
    session.state.enabled.delete("other");
    assert.equal(catalogue.active().length, 0);
  });

  test("knows() ignores a server prefix in either direction", async () => {
    const { catalogue } = setup({ tools: [tool("vscode/read_file")] });
    await catalogue.ensure();
    assert.equal(catalogue.knows("read_file"), true);
    assert.equal(catalogue.knows("vscode/read_file"), true);
    assert.equal(catalogue.knows("write_file"), false);
  });
});
