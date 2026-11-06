import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_CONTEXT_FILES, clampContextFiles } from "../src/domain/prompt/context-file.js";
import { DEFAULT_EXCLUDED_FOLDERS, clampExcludedFolders, parseFolderNames } from "../src/domain/prompt/excluded-folders.js";
import { createPreferences, KEYS } from "../src/page/preferences.js";
import { openPreferences } from "../src/ui/preferences-popup.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const watchers = {};
  return {
    data,
    get: async (key) => data[key],
    set(key, value) { data[key] = value; (watchers[key] || []).forEach((fn) => fn(value)); },
    remove(key) { delete data[key]; },
    watch(key, fn) { (watchers[key] = watchers[key] || []).push(fn); },
  };
}

describe("excluded folders", () => {
  test("a typed list becomes clean names: one per line or comma, no slashes, no empties, no repeats", () => {
    assert.deepEqual(parseFolderNames("node_modules\n./target/, dist/ ,\n\nnode_modules\n/build"), ["node_modules", "target", "dist", "build"]);
    assert.deepEqual(parseFolderNames("   "), []);
  });

  test("nothing saved means the defaults; an empty saved list is respected", () => {
    assert.deepEqual(clampExcludedFolders(undefined), DEFAULT_EXCLUDED_FOLDERS);
    assert.deepEqual(clampExcludedFolders("junk"), DEFAULT_EXCLUDED_FOLDERS);
    assert.deepEqual(clampExcludedFolders([]), []);
    assert.deepEqual(clampExcludedFolders(["a", 7, "a/", "b"]), ["a", "b"]);
  });

  test("the defaults skip the usual suspects", () => {
    for (const name of ["node_modules", "target", ".rustup", ".git"]) assert.ok(DEFAULT_EXCLUDED_FOLDERS.includes(name), name);
  });
});

describe("project instruction files", () => {
  test("a typed list becomes clean names: no ./ or slashes around, no empties, no repeats, at most 20; nothing usable means the defaults", () => {
    assert.deepEqual(clampContextFiles(["./AGENTS.md", "AGENTS.md/", "", "CLAUDE.md", "AGENTS.md"]), ["AGENTS.md", "CLAUDE.md"]);
    assert.deepEqual(clampContextFiles(undefined), DEFAULT_CONTEXT_FILES);
    assert.deepEqual(clampContextFiles("junk"), DEFAULT_CONTEXT_FILES);
  });
});

describe("preferences", () => {
  test("start as the defaults, are saved in storage, and a change of the folders marks the file list as out of date", async () => {
    const storage = fakeStorage();
    const state = { filesChangedAt: 0 };
    const preferences = createPreferences({ storage, state });
    await flush();
    assert.deepEqual(preferences.excludedFolders(), DEFAULT_EXCLUDED_FOLDERS);
    preferences.setFolders(["tmp", "tmp/", "cache"]);
    assert.deepEqual(storage.data[KEYS.folders], ["tmp", "cache"]);
    assert.deepEqual(preferences.excludedFolders(), ["tmp", "cache"]);
    assert.ok(state.filesChangedAt > 0);
    preferences.setChars(5);
    preferences.setCalls(500);
    assert.equal(storage.data[KEYS.chars], 20000, "kept within the slider");
    assert.equal(storage.data[KEYS.calls], 30);
  });

  test("a change made elsewhere (another tab) is picked up", async () => {
    const storage = fakeStorage();
    const state = { filesChangedAt: 0 };
    const preferences = createPreferences({ storage, state });
    storage.set(KEYS.folders, ["only-this"]);
    assert.deepEqual(preferences.excludedFolders(), ["only-this"]);
    assert.ok(state.filesChangedAt > 0);
  });

  test("project instruction files: the defaults until changed, then saved as a clean list", async () => {
    const storage = fakeStorage();
    const preferences = createPreferences({ storage, state: {} });
    await flush();
    assert.deepEqual(preferences.contextFiles(), DEFAULT_CONTEXT_FILES);
    preferences.setContextFiles(["./AGENTS.md", "AGENTS.md", "CLAUDE.md", "  ", "docs/GEMINI.md"]);
    assert.deepEqual(storage.data[KEYS.contextFiles], ["AGENTS.md", "CLAUDE.md", "docs/GEMINI.md"]);
  });

  test("read() gives what the panel shows", async () => {
    const preferences = createPreferences({ storage: fakeStorage({ [KEYS.chars]: 150000, [KEYS.calls]: 12 }), state: {} });
    assert.deepEqual(await preferences.read(), { chars: 150000, calls: 12, asFile: false, folders: DEFAULT_EXCLUDED_FOLDERS, contextFiles: DEFAULT_CONTEXT_FILES });
  });

  test("output as file: off until switched on, saved as true or false, and read back", async () => {
    const storage = fakeStorage();
    const preferences = createPreferences({ storage, state: {} });
    await flush();
    assert.equal(preferences.asFile(), false);
    preferences.setAsFile(true);
    assert.equal(storage.data[KEYS.asFile], true);
    assert.equal((await preferences.read()).asFile, true);
    preferences.setAsFile("yes");
    assert.equal(storage.data[KEYS.asFile], false, "only true counts");
  });
});

describe("preferences panel", () => {
  function open() {
    const w = new JSDOM("<!doctype html><body></body>").window;
    const saved = [];
    openPreferences({
      document: w.document, values: { chars: 100000, calls: 8, folders: ["node_modules", "target"] }, defaults: { folders: ["node_modules", "target", "dist"] },
      save: { chars: (v) => saved.push(["chars", v]), calls: (v) => saved.push(["calls", v]), folders: (v) => saved.push(["folders", v]) },
    });
    const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
    return { w, saved, fire, $: (selector) => w.document.querySelector(selector) };
  }

  test("shows the current values, and each change is saved as it is made", () => {
    const { $, saved, fire } = open();
    assert.equal($("#zs-pref-chars").value, "100000");
    assert.match($("#zs-pref-chars-value").textContent, /100k chars/);
    assert.equal($("#zs-pref-calls-value").textContent, "8 commands");
    assert.equal($("#zs-pref-folders").value, "node_modules\ntarget");

    $("#zs-pref-calls").value = "1"; fire($("#zs-pref-calls"), "input"); fire($("#zs-pref-calls"), "change");
    assert.equal($("#zs-pref-calls-value").textContent, "1 command");
    $("#zs-pref-folders").value = "node_modules, .rustup\n\nbuild/"; fire($("#zs-pref-folders"), "change");
    assert.deepEqual(saved, [["calls", 1], ["folders", ["node_modules", ".rustup", "build"]]]);
  });

  test("restoring the defaults fills the box and saves them", () => {
    const { $, saved } = open();
    $("#zs-pref-reset").click();
    assert.equal($("#zs-pref-folders").value, "node_modules\ntarget\ndist");
    assert.deepEqual(saved, [["folders", ["node_modules", "target", "dist"]]]);
  });

  test("typing in the box does not reach the site's keyboard shortcuts", () => {
    const { w, $ } = open();
    let reached = false;
    w.document.addEventListener("keydown", () => { reached = true; });
    $("#zs-pref-folders").dispatchEvent(new w.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    assert.equal(reached, false);
  });

  test("project instruction files: shown, saved as a clean list, and reset with the defaults", () => {
    const w = new JSDOM("<!doctype html><body></body>").window;
    const saved = [];
    openPreferences({
      document: w.document, values: { chars: 100000, calls: 8, folders: [], contextFiles: ["AGENTS.md"] },
      defaults: { folders: [], contextFiles: ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] },
      save: { chars() {}, calls() {}, folders() {}, contextFiles: (list) => saved.push(list) },
    });
    const $ = (selector) => w.document.querySelector(selector);
    assert.equal($("#zs-pref-context").value, "AGENTS.md");
    $("#zs-pref-context").value = " AGENTS.md \n\nCLAUDE.md";
    $("#zs-pref-context").dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.deepEqual(saved, [["AGENTS.md", "CLAUDE.md"]]);
    $("#zs-pref-reset").click();
    assert.equal($("#zs-pref-context").value, "AGENTS.md\nCLAUDE.md\nGEMINI.md");
    assert.deepEqual(saved, [["AGENTS.md", "CLAUDE.md"], ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]]);
  });

  test("bar and calibration actions are offered and wired", () => {
    const w = new JSDOM("<!doctype html><body></body>").window;
    const called = [];
    openPreferences({
      document: w.document, values: { chars: 100000, calls: 8, folders: [] }, defaults: { folders: [] },
      save: { chars() {}, calls() {}, folders() {} }, corner: "bottom",
      actions: { onToggleCorner: () => called.push("corner"), onCalibrate: () => called.push("cal"), onExportAll: () => called.push("all") },
    });
    const corner = w.document.querySelector("#zs-bar-corner");
    const start = w.document.querySelector("#zs-cal-start");
    const all = w.document.querySelector("#zs-cal-export-all");
    assert.match(corner.textContent, /top right corner/);
    // Clicking a row closes the popup, so the references are taken before the first click.
    corner.click();
    start.click();
    all.click();
    assert.deepEqual(called, ["corner", "cal", "all"]);
  });
});

describe("the attachable files follow the preference", () => {
  test("the list is asked for with the user's own excluded folders instead of the built-in ones", async () => {
    const { createAttachments } = await import("../src/page/attachments.js");
    const asked = [];
    const tools = { runner: { run: async (call) => { asked.push(call.arguments); return "» find_files\n[\"a/b.go\"]"; } }, catalogue: { active: () => [] } };
    const state = { filesChangedAt: 0 };
    const attachments = createAttachments({ provider: {}, state, tools, chat: {}, bar: {}, budget: {}, parts: {}, preferences: { excludedFolders: () => ["tmp", ".rustup"] }, startTurn() {}, diag() {} });
    assert.deepEqual((await attachments.listFiles()).paths, ["a/", "a/b.go"]);
    assert.deepEqual(asked[0].exclude, ["tmp", ".rustup"]);
    assert.equal(asked[0].exclude_only, true);
  });
});
