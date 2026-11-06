import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "../src/application/profile-store.js";
import { profileProblems } from "../src/infrastructure/calibration/index.js";

const PROFILE = (site = "chatgpt.com") => ({
  version: 1, site, name: "ChatGPT", composer: { selector: "#box" }, send: { enter: true }, assistant: { turn: ".a", body: null }, user: { turn: ".u" }, stop: null,
});
function setup(initial) {
  const data = initial === undefined ? {} : { zsProfiles: initial };
  const store = { get: async (key) => data[key], set: async (key, value) => { data[key] = value; } };
  return { profiles: new ProfileStore({ store, problemsOf: profileProblems }), data };
}

describe("ProfileStore", () => {
  test("saves a profile under its site and gives it back", async () => {
    const { profiles } = setup();
    assert.deepEqual(await profiles.save(PROFILE()), { ok: true });
    assert.equal((await profiles.get("chatgpt.com")).composer.selector, "#box");
    assert.equal(await profiles.get("gemini.google.com"), null);
  });

  test("keeps the other sites' profiles when one is saved or removed", async () => {
    const { profiles, data } = setup({ "gemini.google.com": PROFILE("gemini.google.com") });
    await profiles.save(PROFILE());
    assert.deepEqual(Object.keys(data.zsProfiles).sort(), ["chatgpt.com", "gemini.google.com"]);
    await profiles.remove("chatgpt.com");
    assert.deepEqual(Object.keys(data.zsProfiles), ["gemini.google.com"]);
  });

  test("refuses to store something that is not a usable profile", async () => {
    const { profiles, data } = setup();
    const result = await profiles.save({ version: 9 });
    assert.equal(result.ok, false);
    assert.match(result.error, /Not a usable profile/);
    assert.equal(data.zsProfiles, undefined);
  });

  test("survives storage holding something odd", async () => {
    for (const odd of [null, [], "x", 5]) {
      const { profiles } = setup(odd);
      assert.equal(await profiles.get("chatgpt.com"), null);
      assert.deepEqual(await profiles.save(PROFILE()), { ok: true });
    }
  });

  test("exports a profile as readable text and imports it back", async () => {
    const { profiles } = setup();
    assert.equal(await profiles.exportText("chatgpt.com"), null, "nothing to export yet");
    await profiles.save(PROFILE());
    const text = await profiles.exportText("chatgpt.com");
    assert.match(text, /\n  "site": "chatgpt.com"/);
    const other = setup();
    assert.deepEqual(await other.profiles.importText(text, "chatgpt.com"), { ok: true });
    assert.deepEqual(await other.profiles.get("chatgpt.com"), PROFILE());
  });

  test("an import is for this site only, and must be a real profile file", async () => {
    const { profiles } = setup();
    assert.match((await profiles.importText(JSON.stringify(PROFILE("gemini.google.com")), "chatgpt.com")).error, /gemini.google.com, not chatgpt.com/);
    assert.match((await profiles.importText("not json", "chatgpt.com")).error, /not valid JSON/);
    assert.match((await profiles.importText("5", "chatgpt.com")).error, /not a profile/);
    assert.match((await profiles.importText(JSON.stringify({ site: "chatgpt.com" }), "chatgpt.com")).error, /Not a usable profile/);
  });
});

describe("ProfileStore: all sites at once", () => {
  const SITES = { "chatgpt.com": { id: "chatgpt", name: "ChatGPT" }, "chat.openai.com": { id: "chatgpt", name: "ChatGPT" }, "claude.ai": { id: "claude", name: "Claude" } };
  function setupAll(initial) {
    const data = initial === undefined ? {} : { zsProfiles: initial };
    const store = { get: async (key) => data[key], set: async (key, value) => { data[key] = value; } };
    return { profiles: new ProfileStore({ store, problemsOf: profileProblems, siteOf: (host) => SITES[host] }), data };
  }

  test("exports every profile in one file, kept apart per AI (an AI with two hosts keeps both)", async () => {
    const { profiles } = setupAll({ "chatgpt.com": PROFILE("chatgpt.com"), "chat.openai.com": PROFILE("chat.openai.com"), "claude.ai": PROFILE("claude.ai"), "other.test": PROFILE("other.test") });
    const bundle = JSON.parse(await profiles.exportAllText());
    assert.equal(bundle.format, "snapgent-calibrations");
    assert.deepEqual(Object.keys(bundle.sites).sort(), ["chatgpt", "claude", "other.test"]);
    assert.deepEqual(Object.keys(bundle.sites.chatgpt.profiles).sort(), ["chat.openai.com", "chatgpt.com"]);
    assert.equal(bundle.sites.chatgpt.name, "ChatGPT");
  });

  test("nothing is exported when nothing is calibrated", async () => assert.equal(await setupAll().profiles.exportAllText(), null));

  test("reads a file of many profiles per AI, and a single profile file too, and says which AI an import would replace", async () => {
    const source = setupAll({ "chatgpt.com": PROFILE("chatgpt.com"), "claude.ai": PROFILE("claude.ai") });
    const bundle = await source.profiles.exportAllText();
    const { profiles } = setupAll({ "claude.ai": PROFILE("claude.ai") });
    const { groups, skipped } = await profiles.read([bundle, JSON.stringify(PROFILE("chat.openai.com"))]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(groups.map((g) => [g.id, g.name, g.profiles.map((p) => p.site).sort(), g.replaces]).sort(), [
      ["chatgpt", "ChatGPT", ["chat.openai.com", "chatgpt.com"], false],
      ["claude", "Claude", ["claude.ai"], true],
    ]);
  });

  test("a file that is not JSON, not a calibration, or holds an unusable profile is left out and named", async () => {
    const { profiles } = setupAll();
    const { groups, skipped } = await profiles.read(["nope", "5", JSON.stringify({ site: "claude.ai", version: 1 })]);
    assert.deepEqual(groups, []);
    assert.equal(skipped.length, 3);
    assert.match(skipped.join("|"), /not valid JSON.*not a calibration.*claude.ai/);
  });

  test("saving the chosen profiles keeps every other site's calibration", async () => {
    const { profiles, data } = setupAll({ "gemini.google.com": PROFILE("gemini.google.com") });
    await profiles.saveAll([PROFILE("chatgpt.com"), PROFILE("claude.ai")]);
    assert.deepEqual(Object.keys(data.zsProfiles).sort(), ["chatgpt.com", "claude.ai", "gemini.google.com"]);
  });
});


describe('ProfileStore preferences', () => {
  function setupPrefs() {
    let current = { excludedFolders: ['node_modules'], contextFiles: ['AGENTS.md'] };
    const applied = [];
    const prefs = { readPreferences: async () => ({ ...current }), applyPreferences: async (v) => { applied.push(v); current = { ...current, ...v }; } };
    const data = {};
    const store = { get: async (k) => data[k], set: async (k, v) => { data[k] = v; } };
    return { profiles: new ProfileStore({ store, problemsOf: profileProblems, preferences: prefs }), data, applied, getCurrent: () => current };
  }
  test('export and import carry preferences, stored profile stays clean', async () => {
    const a = setupPrefs();
    await a.profiles.save(PROFILE());
    const text = await a.profiles.exportText('chatgpt.com');
    assert.equal(JSON.parse(text).preferences.excludedFolders[0], 'node_modules');
    const b = setupPrefs();
    assert.deepEqual(await b.profiles.importText(text, 'chatgpt.com'), { ok: true });
    assert.equal(b.applied.length, 1);
    assert.equal((await b.profiles.get('chatgpt.com')).preferences, undefined);
  });
  test('old files without preferences leave local settings alone', async () => {
    const b = setupPrefs();
    assert.deepEqual(await b.profiles.importText(JSON.stringify(PROFILE()), 'chatgpt.com'), { ok: true });
    assert.equal(b.applied.length, 0);
  });
  test('export-all and read/saveAll carry preferences', async () => {
    const a = setupPrefs();
    await a.profiles.save(PROFILE());
    assert.equal(JSON.parse(await a.profiles.exportAllText()).preferences.contextFiles[0], 'AGENTS.md');
    const b = setupPrefs();
    const read = await b.profiles.read([await a.profiles.exportAllText()]);
    assert.equal(read.preferences.excludedFolders[0], 'node_modules');
    await b.profiles.saveAll(read.groups[0].profiles, read.preferences);
    assert.equal(b.applied.length, 1);
  });
});
