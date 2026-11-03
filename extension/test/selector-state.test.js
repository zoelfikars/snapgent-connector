import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alternativeSelectors, createCalibratedProvider, learnSelector, relaxSelector } from "../src/infrastructure/calibration/index.js";
import { pageWith } from "./support/jsdom-provider.js";

// A composer in a new chat and in one that is open: the same box, with a different role, placeholder and state.
const GROK_NEW = `<div data-testid="chat-input"><div contenteditable="true" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-label="Ask Grok anything" class="tiptap ProseMirror query-bar-editor"><p data-placeholder="" class="is-empty is-editor-empty"><br></p></div></div>`;
const GROK_OPEN = `<div data-testid="chat-input"><div contenteditable="true" role="textbox" aria-multiline="true" aria-label="Ask Grok anything" class="tiptap ProseMirror query-bar-editor"><p data-placeholder="Ask anything" class="is-empty is-editor-empty"><br></p></div></div>`;
const MISTRAL_NEW = `<div data-chat-input-bar="true"><div class="ProseMirror" contenteditable="true" translate="no" data-placeholder="What do you want to build?"><p><br></p></div></div>`;
const MISTRAL_OPEN = `<form><div data-chat-input-bar="true"><div class="ProseMirror" contenteditable="true" translate="no"><p>hello</p></div></div></form>`;
const page = (html) => pageWith(`<html><body>${html}</body></html>`).document;

describe("relaxSelector", () => {
  test("leaves out what changes between one state of a page and another", () => {
    assert.equal(relaxSelector('[role="combobox"][aria-label="Ask Grok anything"]'), '[aria-label="Ask Grok anything"]');
    assert.equal(relaxSelector('.ProseMirror[data-placeholder="What do you want to build?"]'), ".ProseMirror");
    assert.equal(relaxSelector('div.tiptap.is-empty[aria-expanded=false]'), "div.tiptap");
    assert.equal(relaxSelector('[placeholder="Ask"][data-testid="chat-input"] [role=textbox]'), '[data-testid="chat-input"]');
  });

  test("nothing to leave out, or too little left to point at one thing, gives null", () => {
    for (const selector of ['[aria-label="Send"]', "button.send", '[role="combobox"]', '[data-placeholder="x"]', "div[role=textbox]", ""]) assert.equal(relaxSelector(selector), null, selector);
  });
});

describe("alternativeSelectors", () => {
  test("the relaxed form first, then a text box's role swapped for its sibling roles; never the selector itself", () => {
    assert.deepEqual(alternativeSelectors('[role="combobox"][aria-label="A"]'), ['[aria-label="A"]', '[role="textbox"][aria-label="A"]', '[role="searchbox"][aria-label="A"]']);
    assert.deepEqual(alternativeSelectors('[role="textbox"]'), ['[role="combobox"]', '[role="searchbox"]']);
    assert.deepEqual(alternativeSelectors('[aria-label="Send"]'), []);
  });
});

describe("learning a selector in one state of the page", () => {
  for (const [name, fresh, open] of [["Grok", GROK_NEW, GROK_OPEN], ["Mistral", MISTRAL_NEW, MISTRAL_OPEN]]) {
    test(`${name}: what is learned in a new chat finds the box in an open one too`, () => {
      const document = page(fresh);
      const selector = learnSelector(document.querySelector("[contenteditable]"), { onlyVisible: true });
      assert.ok(selector, "a selector is learned");
      assert.equal(document.querySelectorAll(selector).length, 1);
      assert.equal(page(open).querySelectorAll(selector).length, 1, `${selector} must also match the open chat`);
    });
  }
});

describe("a selector learned in one state still finds the box in another", () => {
  function composerOn(html, selector) {
    const { document, window } = pageWith(`<html><body>${html}</body></html>`, "https://grok.com/c/1");
    const profile = { version: 1, site: "grok.com", name: "Grok", composer: { selector }, send: { enter: true }, assistant: { turn: ".a", body: null }, user: { turn: ".u" }, stop: null };
    return createCalibratedProvider({ document, location: window.location, profile }).getEditor();
  }

  test("a profile made in a new chat (it names the role) works in an open chat", () => {
    assert.ok(composerOn(GROK_OPEN, '[role="combobox"][aria-label="Ask Grok anything"]'));
    assert.ok(composerOn(MISTRAL_OPEN, '.ProseMirror[data-placeholder="What do you want to build?"]'));
  });

  test("a selector that finds the box as it is is used as it is, and one that matches nothing stays unmatched", () => {
    assert.equal(composerOn(GROK_NEW, '[role="combobox"]').getAttribute("role"), "combobox");
    assert.equal(composerOn("<p>nothing here</p>", '[role="combobox"][aria-label="Ask Grok anything"]'), null);
  });

  test("a text box's role is swapped for its sibling roles: a profile made in an open chat works in a new one", () => {
    assert.equal(composerOn(GROK_NEW, '[role="textbox"]').getAttribute("role"), "combobox");
    assert.equal(composerOn(GROK_OPEN, '[role="combobox"]').getAttribute("role"), "textbox");
  });

  test("when no selector form finds it, the page's only text box outside the turns is the composer", () => {
    assert.ok(composerOn(MISTRAL_OPEN, '[data-placeholder="What do you want to build?"]'));
    assert.equal(composerOn(`${MISTRAL_OPEN}<textarea></textarea>`, '[data-placeholder="What do you want to build?"]'), null, "two text boxes: it would be a guess");
    assert.equal(composerOn(`<div class="u">hi <div contenteditable="true">an edit box inside a turn</div></div>${MISTRAL_OPEN}`, '[data-placeholder="x"]').textContent, "hello");
  });
});
