import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

// Meta flips its response mode through a Radix menu, which swallows any click that lands while it is open.
// The start used to fire that flip in the background and send at the same time, so the send was lost.
const OPTION = "composer-mode-option-think_hard";

function metaPage({ startInReflexion = false, modeLabel, onSend, layout = "meta.html" } = {}) {
  const page = loadProvider("meta.js", fixture(`sites/${layout}`), "https://www.meta.ai/prompt/x");
  const { window, document } = page;
  document.body.insertAdjacentHTML("beforeend", `<button data-testid="composer-mode-dropdown-button">${modeLabel || (startInReflexion ? "Réflexion" : "Instantané")}</button>`);
  const modeButton = document.querySelector('[data-testid="composer-mode-dropdown-button"]');
  const events = [];
  let menuOpen = false;
  const openMenu = () => {
    if (menuOpen) return;
    menuOpen = true;
    setTimeout(() => {
      document.body.insertAdjacentHTML("beforeend", `<div data-testid="${OPTION}">Réflexion</div>`);
      document.querySelector(`[data-testid="${OPTION}"]`).addEventListener("click", () => {
        modeButton.textContent = "Réflexion";
        document.querySelector(`[data-testid="${OPTION}"]`).remove();
        menuOpen = false;
      });
    }, 150); // the menu takes a moment to appear, as on the real page
  };
  modeButton.addEventListener("pointerdown", openMenu);
  const textarea = document.querySelector('[data-testid="composer-input"]');
  const pressed = { count: 0 };
  const sendButton = document.querySelector('[data-testid="composer-send-button"]');
  sendButton.addEventListener("click", (event) => {
    events.push({ menuOpenAtSend: menuOpen || !!document.querySelector(`[data-testid="${OPTION}"]`), mode: modeButton.textContent, trusted: event.detail });
    if (onSend) return onSend({ document, textarea, window, pressed });
    if (!menuOpen) textarea.value = ""; // a send while the menu is open is swallowed: the text stays
  });
  sendButton.addEventListener("pointerdown", () => { pressed.count++; });
  window.PointerEvent = window.PointerEvent || window.MouseEvent;
  globalThis.window = window; // the shared setNativeValue helper defaults to the page's window global
  return { ...page, events, modeButton, textarea, pressed };
}

describe("Meta AI start", () => {
  test("the mode flip is finished before the message is sent", async () => {
    const page = metaPage();
    const ready = page.provider.ensureComposerReady("startup"); // the session starter awaits this, then sends
    await ready;
    assert.equal(page.modeButton.textContent, "Réflexion", "readiness waited for the flip");
    await page.provider.typeAndSend("hello", []);
    assert.deepEqual(page.events.map((e) => e.menuOpenAtSend), [false]);
    assert.equal(page.textarea.value, "");
    page.window.close();
    delete globalThis.window;
  });

  test("a send that races a flip still waits for the menu to close", async () => {
    const page = metaPage();
    page.provider.ensureComposerReady("startup"); // deliberately NOT awaited: the old behaviour
    await page.provider.typeAndSend("hello", []);
    assert.deepEqual(page.events.map((e) => e.menuOpenAtSend), [false], "the click never landed on an open menu");
    page.window.close();
    delete globalThis.window;
  });

  test("already in Réflexion: nothing to flip, send goes straight through", async () => {
    const page = metaPage({ startInReflexion: true });
    await page.provider.ensureComposerReady("startup");
    await page.provider.typeAndSend("hello", []);
    assert.equal(page.events.length, 1);
    page.window.close();
    delete globalThis.window;
  });

  test("a label in English ('Thinking') is Réflexion: the mode is not flipped on every start", async () => {
    const page = metaPage({ modeLabel: "Thinking" });
    await page.provider.ensureComposerReady("startup");
    assert.equal(page.document.querySelector(`[data-testid="${OPTION}"]`), null, "the menu was never opened");
    assert.equal(page.modeButton.textContent, "Thinking");
    page.window.close();
    delete globalThis.window;
  });

  test("a send the site accepted, but that leaves the text in the composer and shows no turn or stop button, is recognised", async () => {
    // As seen live on a fresh chat: Meta takes the message, keeps the mirror textarea's value, and its turn list is not found yet.
    const page = metaPage({
      startInReflexion: true,
      onSend: ({ document }) => document.body.insertAdjacentHTML("beforeend", '<div class="shown-turn">⟦ZS-SYS⟧ hello there, this is the first message</div>'),
    });
    await page.provider.typeAndSend("⟦ZS-SYS⟧ hello there, this is the first message", []);
    assert.equal(page.events.length, 1, "no second click: it would send the message twice");
    assert.equal(page.pressed?.count ?? 0, 0);
    page.window.close();
    delete globalThis.window;
  });

  test("a click the page ignores is retried once as a full mouse press", async () => {
    let swallowed = false;
    const page = metaPage({
      startInReflexion: true,
      onSend: ({ textarea, pressed }) => {
        if (!swallowed) { swallowed = true; return; } // the plain .click() is ignored
        textarea.value = "";
        pressed.count++;
      },
    });
    await page.provider.typeAndSend("hello", []);
    assert.equal(page.events.length, 2, "one plain click, then the press's click");
    assert.equal(page.textarea.value, "");
    page.window.close();
    delete globalThis.window;
  });

});

// Since 2026-10 the textarea is a hidden pre-hydration leftover; Meta sends what its Lexical editor holds.
describe("Meta AI composer with the Lexical editor (captured 2026-10 structure)", () => {
  function lexicalPage() {
    const page = metaPage({ startInReflexion: true, layout: "meta-lexical.html" });
    const { window, document } = page;
    // jsdom has no clipboard: just enough of one for the paste the adapter dispatches.
    window.DataTransfer = class { constructor() { this.data = {}; } setData(type, value) { this.data[type] = value; } getData(type) { return this.data[type] || ""; } };
    window.ClipboardEvent = class extends window.Event { constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData; } };
    const editor = document.querySelector("[data-lexical-editor]");
    const textarea = document.querySelector("textarea");
    const sent = [];
    // Lexical learns the caret position from the asynchronous `selectionchange`: input that arrives right after focus()
    // is ignored. It applies a paste over the selection; the pre-hydration textarea does nothing for Meta.
    const lexical = { focusedAt: 0, acceptsPaste: true, acceptsInsert: true, accepts: () => Date.now() - lexical.focusedAt >= 100 };
    const nativeFocus = editor.focus.bind(editor);
    editor.focus = () => { lexical.focusedAt = Date.now(); nativeFocus(); };
    editor.addEventListener("paste", (event) => {
      if (lexical.acceptsPaste && lexical.accepts()) editor.textContent = event.clipboardData.getData("text/plain");
    });
    document.execCommand = (command, _ui, value) => {
      if (command !== "insertText" || !lexical.acceptsInsert || !lexical.accepts()) return false;
      editor.textContent = value;
      return true;
    };
    document.querySelector('[data-testid="composer-send-button"]').addEventListener("click", () => {
      if (!editor.textContent.trim()) return; // Meta reads Lexical, not the textarea
      sent.push(editor.textContent);
      editor.textContent = "";
    });
    return { ...page, editor, textarea, sent, lexical };
  }

  test("the text goes into the Lexical editor and is sent, not into the dead textarea", async () => {
    const page = lexicalPage();
    await page.provider.typeAndSend("⟦ZS-SYS⟧ first message", []);
    assert.deepEqual(page.sent, ["⟦ZS-SYS⟧ first message"]);
    assert.equal(page.textarea.value, "", "the pre-hydration textarea was left alone");
    page.window.close();
    delete globalThis.window;
  });

  test("whatever the user already typed is replaced, not appended to", async () => {
    const page = lexicalPage();
    page.editor.textContent = "half-typed draft";
    await page.provider.typeAndSend("the real message", []);
    assert.deepEqual(page.sent, ["the real message"]);
    page.window.close();
    delete globalThis.window;
  });

  test("the composer text it reports is what Lexical holds", async () => {
    const page = lexicalPage();
    page.editor.textContent = "typed by hand";
    assert.equal(page.provider.editorText(), "typed by hand");
    page.window.close();
    delete globalThis.window;
  });

  test("a paste that arrives before Lexical has synced its selection is not lost: the adapter lets it settle first", async () => {
    const page = lexicalPage(); // the fake ignores input within 100 ms of focus(), like the real editor
    await page.provider.typeAndSend("⟦ZS-SYS⟧ right after focus", []);
    assert.deepEqual(page.sent, ["⟦ZS-SYS⟧ right after focus"]);
    page.window.close();
    delete globalThis.window;
  });

  test("if the paste is ignored altogether, insertText is the second way in", async () => {
    const page = lexicalPage();
    page.lexical.acceptsPaste = false;
    await page.provider.typeAndSend("typed the other way", []);
    assert.deepEqual(page.sent, ["typed the other way"]);
    page.window.close();
    delete globalThis.window;
  });

  test("an editor that takes nothing is an error naming the cause, not a silent empty send", async () => {
    const page = lexicalPage();
    page.lexical.acceptsPaste = false;
    page.lexical.acceptsInsert = false;
    await assert.rejects(() => page.provider.typeAndSend("hello", []), /did not take the typed text/);
    assert.deepEqual(page.sent, []);
    page.window.close();
    delete globalThis.window;
  });
});
