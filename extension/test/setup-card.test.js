import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SETUP_STEPS, createSetupCard, shouldShowSetup } from "../src/ui/setup-card.js";

describe("shouldShowSetup", () => {
  const base = { dismissed: false, bridgeConnected: false, hasSession: false, chatIsEmpty: true };
  test("a blank chat with no bridge", () => assert.equal(shouldShowSetup(base), true));
  test("a chat that has a session", () => assert.equal(shouldShowSetup({ ...base, chatIsEmpty: false, hasSession: true }), true));
  test("someone just reading an old conversation is left alone", () => assert.equal(shouldShowSetup({ ...base, chatIsEmpty: false }), false));
  test("once dismissed, or once the bridge is connected, never", () => {
    assert.equal(shouldShowSetup({ ...base, dismissed: true }), false);
    assert.equal(shouldShowSetup({ ...base, bridgeConnected: true }), false);
  });
});

function setup(options = {}) {
  const { window } = new JSDOM("<!doctype html><body></body>", { url: "https://chatgpt.com/" });
  const dismissed = [];
  const card = createSetupCard({ document: window.document, githubUrl: 'https://example.test/?a=1&b="2"', onDismiss: () => dismissed.push(1), ...options });
  return { window, card, dismissed, $: (s) => window.document.querySelector(s) };
}

describe("setup card", () => {
  test("is not in the page until first shown, and then lists every step", () => {
    const t = setup();
    assert.equal(t.$("#zs-setup"), null);
    t.card.show();
    assert.equal(t.card.isShown(), true);
    assert.equal(t.window.document.querySelectorAll("#zs-setup-steps li").length, SETUP_STEPS.length);
  });

  test("tells every platform how to start the bridge and mentions the one-time approval", () => {
    const t = setup();
    t.card.show();
    const text = t.$("#zs-setup-steps").textContent;
    for (const word of ["snapgent.exe", "./snapgent", "snapgent.py", "y", "Start"]) assert.ok(text.includes(word), word);
    assert.match(text, /only the first time/);
  });

  test("hide and show toggle the same card", () => {
    const t = setup();
    t.card.show();
    t.card.hide();
    assert.equal(t.card.isShown(), false);
    t.card.show();
    assert.equal(t.window.document.querySelectorAll("#zs-setup").length, 1);
  });

  test("the link is escaped into the attribute and copies to the clipboard", async () => {
    const t = setup();
    const copied = [];
    Object.defineProperty(t.window.navigator, "clipboard", { value: { writeText: (text) => copied.push(text) }, configurable: true });
    t.card.show();
    assert.equal(t.$("#zs-setup-link").value, 'https://example.test/?a=1&b="2"');
    t.$("#zs-setup-copy").dispatchEvent(new t.window.Event("click"));
    assert.deepEqual(copied, ['https://example.test/?a=1&b="2"']);
    assert.equal(t.$("#zs-setup-copy").textContent, "Copied!");
  });

  test("when the clipboard API is unavailable the link is selected for a manual copy", () => {
    const t = setup();
    t.card.show();
    let executed = null;
    t.window.document.execCommand = (name) => { executed = name; return true; };
    t.$("#zs-setup-copy").dispatchEvent(new t.window.Event("click"));
    assert.equal(executed, "copy");
  });

  test("OK dismisses for good and hides the card", () => {
    const t = setup();
    t.card.show();
    t.$("#zs-setup-dismiss").dispatchEvent(new t.window.Event("click"));
    assert.deepEqual(t.dismissed, [1]);
    assert.equal(t.card.isShown(), false);
  });
});
