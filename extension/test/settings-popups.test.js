import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { openMcpSettings } from "../src/ui/mcp-settings.js";
import { openSkillsSettings } from "../src/ui/skills-settings.js";
import { openCalibrationImport } from "../src/ui/calibration-import.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const newPage = () => new JSDOM("<!doctype html><body></body>").window;
const click = (el) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)("click", { bubbles: true }));
const change = (el, checked) => { el.checked = checked; el.dispatchEvent(new (el.ownerDocument.defaultView.Event)("change", { bubbles: true })); };

describe("MCP settings popup", () => {
  function open(over = {}) {
    const w = newPage();
    const enabled = new Set(["snapgent"]);
    const events = [];
    const handle = openMcpSettings({
      document: w.document,
      options: [{ id: "snapgent", name: "VS Code", tools: 28 }, { id: "x", name: "<b>Evil</b>", tools: 0 }],
      isEnabled: (id) => enabled.has(id),
      setEnabled: (id, on) => { on ? enabled.add(id) : enabled.delete(id); events.push(["set", id, on]); },
      onToggle: () => events.push(["toggle"]),
      onClose: () => events.push(["closed"]),
      ...over,
    });
    return { w, enabled, events, handle, popup: () => w.document.getElementById("zs-mcp-pop") };
  }

  test("lists every server with its tool count and current state, names escaped", () => {
    const { popup } = open();
    const rows = [...popup().querySelectorAll(".zs-mcp-row")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".zs-mcp-row-meta").textContent, "28 tools");
    assert.equal(rows[0].querySelector("input").checked, true);
    assert.equal(rows[1].querySelector("input").checked, false);
    assert.equal(rows[1].querySelector(".zs-mcp-row-name").textContent, "<b>Evil</b>");
    assert.equal(rows[1].querySelector(".zs-mcp-row-name b"), null);
  });

  test("switching a server reports it and lets the dropdown refresh at once", () => {
    const { popup, events, enabled } = open();
    change(popup().querySelector('input[data-id="x"]'), true);
    assert.deepEqual(events, [["set", "x", true], ["toggle"]]);
    assert.ok(enabled.has("x"));
  });

  test("closing: the X button and a click outside the card; only one popup exists at a time", () => {
    const { popup, events, w } = open();
    click(popup().querySelector(".zs-mcp-pop-close"));
    assert.equal(popup(), null);
    assert.deepEqual(events, [["closed"]]);
    const again = open();
    again.w.document.defaultView.document.getElementById("zs-mcp-pop").dispatchEvent(new again.w.Event("click", { bubbles: true }));
    assert.equal(again.popup(), null, "clicking the backdrop closes it");
    const doc = newPage().document;
    openMcpSettings({ document: doc, options: [], isEnabled: () => false, setEnabled() {} });
    openMcpSettings({ document: doc, options: [], isEnabled: () => false, setEnabled() {} });
    assert.equal(doc.querySelectorAll("#zs-mcp-pop").length, 1);
    void w;
  });
});

const SKILL = "---\nname: commit-message\ndescription: Write good commits\n---\nBody";

function skillsService(over = {}) {
  const state = {
    all: [{ name: "alpha", description: "A <i>skill</i>" }],
    globals: {},
    enabled: { alpha: true },
    calls: [],
  };
  const service = {
    get all() { return state.all; },
    get globals() { return state.globals; },
    validate: (text) => (text.includes("name: commit-message") ? { ok: true, name: "commit-message", description: "Write good commits" } : { ok: false, error: "Missing frontmatter" }),
    isEnabled: (name) => state.enabled[name] !== false,
    setEnabled: (name, on) => { state.enabled[name] = on; state.calls.push(["setEnabled", name, on]); },
    saveGlobal: (text) => { state.calls.push(["saveGlobal"]); state.globals = { ...state.globals, "commit-message": { description: "Write good commits", text } }; return { ok: true }; },
    removeGlobal: (name) => { state.calls.push(["removeGlobal", name]); const { [name]: _gone, ...rest } = state.globals; state.globals = rest; },
    importText: async (text) => { state.calls.push(["importText", text]); return state.importResult || { ok: true, name: "commit-message" }; },
    load: async () => { state.calls.push(["load"]); },
    ...over,
  };
  return { service, state };
}

describe("Skills settings popup", () => {
  function open({ service: overrides, loadOnOpen = false, FileReaderImpl } = {}) {
    const w = newPage();
    const { service, state } = skillsService(overrides);
    openSkillsSettings({ document: w.document, skills: service, maxFileBytes: 20 * 1024, loadOnOpen, FileReaderImpl });
    const $ = (selector) => w.document.querySelector(selector);
    return { w, state, $, $$: (selector) => [...w.document.querySelectorAll(selector)] };
  }
  const type = (el, text) => { el.value = text; };

  test("the list shows skills (escaped) and toggling one is saved", () => {
    const { $, $$, state } = open();
    assert.equal($$(".zs-mcp-row-name")[0].textContent, "alpha");
    assert.equal($(".zs-mcp-row-meta").textContent, "A <i>skill</i>");
    assert.equal($(".zs-mcp-row-meta i"), null);
    change($('input[data-name="alpha"]'), false);
    assert.deepEqual(state.calls, [["setEnabled", "alpha", false]]);
  });

  test("empty states are explained", () => {
    const { $ } = open({ service: { get all() { return []; } } });
    assert.match($(".zs-mcp-pop-list").textContent, /No skills found in \.snapgent\/skills/);
    assert.match($(".zs-mcp-pop-card").textContent, /Empty\. Use "Save to global"/);
  });

  test("opening in a VS Code workspace refreshes the list from disk", async () => {
    const { state } = open({ loadOnOpen: true });
    await flush();
    assert.deepEqual(state.calls, [["load"]]);
  });

  test("a refresh that finishes while you are pasting does not wipe what you typed", async () => {
    let finish;
    const { $, w } = open({ loadOnOpen: true, service: { load: () => new Promise((resolve) => { finish = resolve; }) } });
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), "half typed");
    finish();
    await flush();
    assert.equal(w.document.querySelector("#zs-skill-text").value, "half typed");
  });

  test("paste -> review -> confirm imports the skill and returns to the list", async () => {
    const { $, state } = open();
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), SKILL);
    click($("#zs-skill-review"));
    assert.match($(".zs-mcp-pop-card").textContent, /Review carefully[\s\S]*commit-message[\s\S]*Write good commits/);
    assert.equal($("pre").textContent, SKILL);
    click($("#zs-skill-confirm"));
    await flush();
    assert.deepEqual(state.calls.map((c) => c[0]), ["importText", "load"]);
    assert.ok($("#zs-skill-import"), "back on the list");
  });

  test("an invalid skill is explained and stays on the paste view", () => {
    const { $ } = open();
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), "no frontmatter");
    click($("#zs-skill-review"));
    assert.match($(".zs-mcp-pop-note[style*='ff6b6b']").textContent, /Missing frontmatter/);
    assert.ok($("#zs-skill-text"));
    assert.equal($("#zs-skill-text").value, "no frontmatter", "what you typed is kept");
  });

  test("a skill whose name already exists is refused at review", () => {
    const { $ } = open({ service: { get all() { return [{ name: "commit-message", description: "x" }]; } } });
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), SKILL);
    click($("#zs-skill-review"));
    assert.match($(".zs-mcp-pop-note[style*='ff6b6b']").textContent, /already exists/);
  });

  test("a failed import shows the reason and keeps the review view", async () => {
    const { $, state } = open();
    state.importResult = { ok: false, error: "create_file is not available on this server." };
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), SKILL);
    click($("#zs-skill-review"));
    click($("#zs-skill-confirm"));
    await flush();
    assert.match($(".zs-mcp-pop-note[style*='ff6b6b']").textContent, /create_file is not available/);
    assert.ok($("#zs-skill-confirm"));
  });

  test("save to global, then install it from the library and delete it", () => {
    const { $, $$, state } = open();
    click($("#zs-skill-import"));
    type($("#zs-skill-text"), SKILL);
    click($("#zs-skill-review"));
    click($("#zs-skill-global"));
    assert.equal($$(".zs-gskill-install").length, 1);
    click($(".zs-gskill-install"));
    assert.equal($("pre").textContent, SKILL, "install goes through the same review");
    click($("#zs-skill-back"));
    click($("#zs-skill-cancel"));
    click($(".zs-gskill-del"));
    assert.equal($$(".zs-gskill-install").length, 0);
    assert.deepEqual(state.calls.map((c) => c[0]), ["saveGlobal", "removeGlobal"]);
  });

  test("a file bigger than 20 KB is refused; a readable file fills the box", () => {
    class FakeReader {
      readAsText(file) { this.result = file.content; this.onload(); }
    }
    const { $, w } = open({ FileReaderImpl: FakeReader });
    click($("#zs-skill-import"));
    const input = $("#zs-skill-file");
    Object.defineProperty(input, "files", { value: [{ size: 30 * 1024, content: "big" }], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    assert.match($(".zs-mcp-pop-note[style*='ff6b6b']").textContent, /too large/);
    const again = $("#zs-skill-file");
    Object.defineProperty(again, "files", { value: [{ size: 100, content: SKILL }], configurable: true });
    again.dispatchEvent(new w.Event("change"));
    assert.equal($("#zs-skill-text").value, SKILL);
  });
});

describe("Import calibrations popup", () => {
  const groups = [
    { id: "chatgpt", name: "ChatGPT", profiles: [{ site: "chatgpt.com" }, { site: "chat.openai.com" }], replaces: true },
    { id: "claude", name: "<b>Claude</b>", profiles: [{ site: "claude.ai" }], replaces: false },
  ];

  test("one row per AI with its own tick, a note for the ones it would replace, and nothing a name says becomes markup", () => {
    const w = newPage();
    openCalibrationImport({ document: w.document, groups, onImport() {} });
    const rows = [...w.document.querySelectorAll(".zs-mcp-row")];
    assert.deepEqual(rows.map((r) => r.querySelector(".zs-mcp-row-meta").textContent), ["2 sites · replaces its current calibration", "1 site"]);
    assert.equal(w.document.querySelector("b"), null);
    assert.ok([...w.document.querySelectorAll(".zs-mcp-check")].every((box) => box.checked));
  });

  test("Import hands over only the AIs left ticked, and closes", () => {
    const w = newPage();
    const taken = [];
    openCalibrationImport({ document: w.document, groups, onImport: (ids) => taken.push(ids) });
    w.document.querySelector('.zs-mcp-check[data-id="chatgpt"]').checked = false;
    click(w.document.querySelector(".zs-cal-import-go"));
    assert.deepEqual(taken, [["claude"]]);
    assert.equal(w.document.getElementById("zs-mcp-pop"), null);
  });

  test("files with nothing usable say so, and cannot be imported", () => {
    const w = newPage();
    openCalibrationImport({ document: w.document, groups: [], skipped: ["a file that is not valid JSON"], onImport() {} });
    assert.match(w.document.querySelector(".zs-mcp-pop-note").textContent, /Left out: a file that is not valid JSON/);
    assert.ok(w.document.querySelector(".zs-cal-import-go").disabled);
  });
});
