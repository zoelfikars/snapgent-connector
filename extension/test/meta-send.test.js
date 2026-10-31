import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

// Meta flips its response mode through a Radix menu, which swallows any click that lands while it is open.
// The start used to fire that flip in the background and send at the same time, so the send was lost.
const OPTION = "composer-mode-option-think_hard";

function metaPage({ startInReflexion = false, modeLabel, onSend } = {}) {
  const page = loadProvider("meta.js", fixture("sites/meta.html"), "https://www.meta.ai/prompt/x");
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
  const sendButton = document.querySelector('[data-testid="composer-send-button"]');
  sendButton.addEventListener("click", (event) => {
    events.push({ menuOpenAtSend: menuOpen || !!document.querySelector(`[data-testid="${OPTION}"]`), mode: modeButton.textContent, trusted: event.detail });
    if (onSend) return onSend({ document, textarea, window, pressed });
    if (!menuOpen) textarea.value = ""; // a send while the menu is open is swallowed: the text stays
  });
  const pressed = { count: 0 };
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
