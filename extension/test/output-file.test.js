import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createOutputFile, fileNote } from "../src/page/output-file.js";
import { createMessageBudget } from "../src/page/message-budget.js";
import { profileProblems, updateProfile } from "../src/infrastructure/calibration/profile.js";
import { openPreferences } from "../src/ui/preferences-popup.js";
import { SESSION_PHRASE } from "../src/domain/constants.js";

const profile = { version: 1, site: "x.test", name: "X", composer: { selector: "textarea" }, send: { enter: true }, assistant: { turn: "a" }, user: { turn: "u" } };
const long = "x".repeat(30000);

function setup({ asFile = true, attach } = {}) {
  const attached = [];
  const provider = { attachFile: attach || (async (file, method) => { attached.push({ file, method }); return { method, handled: true }; }) };
  const budget = { asFile: () => asFile, limit: () => 20000 };
  const output = createOutputFile({ provider, budget, sleep: async () => {}, makeFile: (text) => ({ text }) });
  return { attached, output };
}

describe("output as file: the message", () => {
  test("a message over the size is attached through the file input, and a short note is typed instead", async () => {
    const { attached, output } = setup();
    assert.equal(await output.prepare(long), fileNote(30000));
    assert.equal(attached.length, 1);
    assert.equal(attached[0].method, "input");
    assert.equal(attached[0].file.text, long);
  });

  test("a message that fits, or the option being off, leaves the text alone", async () => {
    const on = setup();
    assert.equal(await on.output.prepare("short"), "short");
    const off = setup({ asFile: false });
    assert.equal(await off.output.prepare(long), long);
    assert.equal(on.attached.length + off.attached.length, 0);
  });

  test("the start message is never turned into a file", async () => {
    const { attached, output } = setup();
    const start = `${SESSION_PHRASE} ${long}`;
    assert.equal(await output.prepare(start), start);
    assert.equal(attached.length, 0);
  });

  test("when the page has no file input the message is cut to fit instead", async () => {
    const { output } = setup({ attach: async () => { throw new Error("no file input"); } });
    const text = await output.prepare(long);
    assert.ok(text.length <= 20000);
    assert.match(text, /characters omitted/);
  });
});

describe("output as file: where the choice is kept", () => {
  const storage = { get: async () => undefined, watch() {}, remove() {}, set() {} };
  const budgetFor = (provider) => createMessageBudget({ storage, hostname: "x.test", provider, diag() {} });

  test("this AI's own choice wins over the general one, true or false", () => {
    const provider = { limits: { asFile: true }, conversationKey: () => "k" };
    const budget = budgetFor(provider);
    assert.equal(budget.asFile(), true);
    provider.limits = { asFile: false };
    assert.equal(budget.asFile(), false);
    provider.limits = null;
    assert.equal(budget.asFile(), false, "the general value, off by default");
  });

  test("it goes into the calibration with the other two values, and only a true or false is accepted", () => {
    const set = updateProfile(profile, "limits", { limits: { chars: 60000, calls: 20, asFile: true } }).profile;
    assert.deepEqual(set.limits, { chars: 60000, calls: 20, asFile: true });
    assert.deepEqual(profileProblems(set), []);
    assert.deepEqual(updateProfile(set, "limits", { limits: { asFile: false } }).profile.limits, { asFile: false });
    assert.equal(profileProblems({ ...profile, limits: { asFile: "yes" } }).length, 1);
  });
});

describe("output as file: the preferences panel", () => {
  function open(values, save) {
    const w = new JSDOM("<!doctype html><body></body>").window;
    openPreferences({ document: w.document, values: { chars: 100000, calls: 8, folders: [], ...values }, defaults: { folders: [] }, save: { chars() {}, calls() {}, folders() {}, ...save } });
    return { w, $: (selector) => w.document.querySelector(selector) };
  }

  test("the checkbox shows the saved value and saves a change", () => {
    const saved = [];
    const { w, $ } = open({ asFile: true }, { asFile: (v) => saved.push(v) });
    assert.equal($("#zs-pref-asfile").checked, true);
    $("#zs-pref-asfile").checked = false;
    $("#zs-pref-asfile").dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.deepEqual(saved, [false]);
  });

  test("with \"Only for this site\" ticked it goes to this AI's calibration with the sliders", () => {
    const site = [];
    const { w, $ } = open({ asFile: false, site: { chars: 50000 } }, { site: (v) => site.push(v) });
    $("#zs-pref-asfile").checked = true;
    $("#zs-pref-asfile").dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.deepEqual(site, [{ chars: 50000, calls: 8, asFile: true }], "the slider shows this AI's own size, so that is what is kept");
  });
});
