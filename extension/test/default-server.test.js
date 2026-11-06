import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERVER_ID, migratedTarget, migratedToggles } from "../src/domain/tools/default-server.js";
import { ServerDirectory } from "../src/application/server-directory.js";
import { createSettings } from "../src/page/settings.js";

const memory = (data) => ({ get: async (key) => data[key], set: (key, value) => { data[key] = value; }, commit: async (key, value) => { data[key] = value; }, watch() {} });

describe("the default server's id (it was \"vscode\" in older versions)", () => {
  test("an old stored target becomes the new id, any other one is kept", () => {
    assert.equal(migratedTarget("vscode"), DEFAULT_SERVER_ID);
    assert.equal(migratedTarget("git"), "git");
    assert.equal(migratedTarget(undefined), undefined);
  });

  test("stored switches move to the new id; one already under the new id wins; nothing to do returns the same object", () => {
    assert.deepEqual(migratedToggles({ vscode: false, a: true }), { a: true, [DEFAULT_SERVER_ID]: false });
    assert.deepEqual(migratedToggles({ vscode: false, [DEFAULT_SERVER_ID]: true }), { [DEFAULT_SERVER_ID]: true });
    const same = { a: false };
    assert.equal(migratedToggles(same), same);
  });

  test("the server directory reads an old switch as the new server's and saves it under the new id", async () => {
    const data = { zsMcpEnabled: { vscode: false } };
    const directory = new ServerDirectory({ store: memory(data), liveServers: () => [] });
    await directory.ready;
    assert.equal(directory.isEnabled(DEFAULT_SERVER_ID), false);
    assert.deepEqual(data.zsMcpEnabled, { [DEFAULT_SERVER_ID]: false });
  });

  test("a stored target of an older version is the default server now, and is saved that way", async () => {
    const data = { zsSelectedMcpTarget: "vscode" };
    const settings = createSettings({ storage: memory(data), location: {}, onChange() {} });
    await settings.ready;
    assert.equal(settings.target(), DEFAULT_SERVER_ID);
    assert.equal(data.zsSelectedMcpTarget, DEFAULT_SERVER_ID);
  });
});
