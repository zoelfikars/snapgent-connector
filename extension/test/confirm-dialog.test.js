import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createConfirmDialog } from "../src/ui/confirm-dialog.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page(options = {}) {
  const dom = new JSDOM("<!doctype html><body><p>host page</p></body>");
  const { document, Event } = dom.window;
  const dialog = createConfirmDialog({ document, shadowMode: "open", allowDelayMs: 30, timeoutMs: 2000, ...options });
  const hosts = () => [...document.documentElement.children].filter((el) => el.shadowRoot);
  const shadow = () => hosts().at(-1)?.shadowRoot;
  const click = (selector) => {
    const event = new Event("click", { bubbles: true, cancelable: true });
    shadow().querySelector(selector).dispatchEvent(event);
    return event;
  };
  return { dom, document, dialog, shadow, hosts, click, window: dom.window };
}

const REQUEST = { description: "Delete file: src/a.js", tool: "delete_file", risk: "destructive" };

describe("confirm dialog", () => {
  test("shows what is about to happen, as text, with a risk label, and puts Deny in focus", async () => {
    const p = page();
    const answer = p.dialog.ask({ ...REQUEST, description: '<img src=x onerror="alert(1)"> Delete file: a' });
    await sleep(5);
    const action = p.shadow().querySelector(".action");
    assert.equal(action.textContent, '<img src=x onerror="alert(1)"> Delete file: a');
    assert.equal(action.querySelector("img"), null, "never parsed as HTML");
    assert.equal(p.shadow().querySelector(".risk").textContent, "Deletes data");
    assert.equal(p.shadow().activeElement, p.shadow().querySelector(".deny"));
    p.click(".deny");
    assert.equal(await answer, false);
  });

  test("Deny, and the dialog disappears from the page", async () => {
    const p = page();
    const answer = p.dialog.ask(REQUEST);
    await sleep(5);
    assert.equal(p.hosts().length, 1);
    p.click(".deny");
    assert.equal(await answer, false);
    assert.equal(p.hosts().length, 0);
  });

  test("Allow is disabled at first, then a real click approves", async () => {
    const p = page({ isTrusted: () => true });
    const answer = p.dialog.ask(REQUEST);
    await sleep(5);
    assert.equal(p.shadow().querySelector(".allow").disabled, true);
    p.click(".allow"); // too early
    await sleep(60);
    assert.equal(p.shadow().querySelector(".allow").disabled, false);
    p.click(".allow");
    assert.equal(await answer, true);
  });

  test("a click a page script fabricated is ignored (untrusted event)", async () => {
    const p = page(); // default isTrusted: event.isTrusted, which is false for dispatchEvent
    const answer = p.dialog.ask({ ...REQUEST });
    await sleep(60);
    p.click(".allow");
    p.click(".allow");
    await sleep(10);
    assert.equal(p.hosts().length, 1, "still waiting for the human");
    p.click(".deny");
    assert.equal(await answer, false);
  });

  test("Esc, a click on the backdrop and the timeout all mean no", async () => {
    let p = page();
    let answer = p.dialog.ask(REQUEST);
    await sleep(5);
    const cancel = new p.window.Event("cancel", { cancelable: true });
    p.shadow().querySelector("dialog").dispatchEvent(cancel);
    assert.equal(await answer, false);
    assert.equal(cancel.defaultPrevented, true);

    p = page();
    answer = p.dialog.ask(REQUEST);
    await sleep(5);
    p.shadow().querySelector("dialog").dispatchEvent(new p.window.Event("click", { bubbles: true }));
    assert.equal(await answer, false);

    p = page({ timeoutMs: 40 });
    assert.equal(await p.dialog.ask(REQUEST), false);
    assert.equal(p.hosts().length, 0);
  });

  test("questions are asked one at a time, in order", async () => {
    const p = page({ isTrusted: () => true });
    const first = p.dialog.ask({ ...REQUEST, description: "first" });
    const second = p.dialog.ask({ ...REQUEST, description: "second" });
    await sleep(10);
    assert.equal(p.hosts().length, 1);
    assert.equal(p.shadow().querySelector(".action").textContent, "first");
    p.click(".deny");
    assert.equal(await first, false);
    // The second question appears a moment later and its Allow arms after allowDelayMs; wait for that, not for a fixed time.
    for (let waited = 0; waited < 2000; waited += 10) {
      const allow = p.shadow() && p.shadow().querySelector(".allow");
      if (allow && !allow.disabled && p.shadow().querySelector(".action").textContent === "second") break;
      await sleep(10);
    }
    assert.equal(p.shadow().querySelector(".action").textContent, "second");
    p.click(".allow");
    assert.equal(await second, true);
  });

  test("an overlong description is cut, an unknown risk still gets a label", async () => {
    const p = page();
    const answer = p.dialog.ask({ description: "x".repeat(5000), risk: "something-new" });
    await sleep(5);
    assert.equal(p.shadow().querySelector(".action").textContent.length, 600);
    assert.equal(p.shadow().querySelector(".risk").textContent, "Needs your approval");
    p.click(".deny");
    await answer;
  });

  test("by default the shadow root is closed: the page cannot look inside or change the text", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const dialog = createConfirmDialog({ document: dom.window.document, timeoutMs: 50 });
    const answer = dialog.ask(REQUEST);
    await sleep(5);
    const host = dom.window.document.documentElement.lastElementChild;
    assert.equal(host.shadowRoot, null);
    assert.equal(await answer, false);
  });
});
