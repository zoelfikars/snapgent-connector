import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createInputCover } from "../src/ui/input-cover.js";

const open = [];
afterEach(() => { while (open.length) open.pop().close(); }); // stops the frame loops, so the process can exit
const frames = (n = 3) => new Promise((resolve) => setTimeout(resolve, 20 * n));

function page(providerOver = () => ({})) {
  const dom = new JSDOM(`<body><div id="card"><div id="editor" contenteditable="true"></div></div></body>`, { url: "https://example.test/", pretendToBeVisual: true });
  const { window } = dom;
  open.push(window);
  const { document } = window;
  // A real browser throws "Illegal invocation" when getComputedStyle is called without its window (a detached reference).
  const nativeComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = function (node) {
    if (this !== window) throw new TypeError("'getComputedStyle' called on an object that does not implement interface Window.");
    return nativeComputedStyle(node);
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.id === "card" ? { left: 90, top: 380, width: 640, height: 100, right: 730, bottom: 480 } : { left: 100, top: 400, width: 600, height: 30, right: 700, bottom: 430 };
  };
  const state = { overlay: false, editor: document.getElementById("editor") };
  const provider = { getEditor: () => state.editor, overlayBlocking: () => state.overlay, ...providerOver(document) };
  const cover = createInputCover({ document, provider });
  return { document, window, state, cover };
}
const coverEl = (document) => document.getElementById("zs-input-cover");

describe("input cover", () => {
  test("turning it on masks the typed text and lays a labelled cover over the editor", async () => {
    const { cover, document, state } = page();
    cover.set(true);
    await frames();
    assert.ok(state.editor.classList.contains("zs-typing"));
    const el = coverEl(document);
    assert.match(el.textContent, /Agent is working/);
    assert.deepEqual([el.style.display, el.dataset.on], ["flex", "1"]);
    assert.ok(el.style.left && el.style.top && el.style.width && el.style.height, "sized to the editor");
    assert.equal(document.querySelectorAll("#zs-input-cover").length, 1);
  });

  test("turning it on twice does not make a second cover", async () => {
    const { cover, document } = page();
    cover.set(true);
    cover.set(true);
    await frames();
    assert.equal(document.querySelectorAll("#zs-input-cover").length, 1);
  });

  test("turning it off hides it, shows the text again and stops following the editor", async () => {
    const { cover, document, state } = page();
    cover.set(true);
    await frames();
    cover.set(false);
    const el = coverEl(document);
    assert.deepEqual([el.style.display, el.dataset.on, state.editor.classList.contains("zs-typing")], ["none", "", false]);
    el.style.left = "7px";
    await frames();
    assert.equal(el.style.left, "7px", "the per-frame loop has stopped");
  });

  test("with no editor on the page there is nothing to cover; and off before on is harmless", async () => {
    const { cover, document, state } = page();
    state.editor = null;
    cover.set(true);
    assert.equal(coverEl(document), null);
    assert.doesNotThrow(() => cover.set(false));
  });

  test("a login or bot-check overlay hides the cover and it comes back once the overlay is gone", async () => {
    const { cover, document, state } = page();
    cover.set(true);
    await frames();
    state.overlay = true;
    await frames();
    assert.equal(coverEl(document).style.display, "none");
    assert.equal(coverEl(document).dataset.on, "1", "still intended on");
    state.overlay = false;
    await frames();
    assert.equal(coverEl(document).style.display, "flex");
  });

  test("a site that recreates the editor node (Vue) gets the mask put back on the new node", async () => {
    const { cover, document, state } = page();
    cover.set(true);
    await frames();
    const fresh = document.createElement("div");
    fresh.id = "editor2";
    state.editor = fresh;
    document.body.appendChild(fresh);
    await frames();
    assert.ok(fresh.classList.contains("zs-typing"));
  });

  test("a provider that names a cover target (a whole composer card) sizes to it, not to the editor line", async () => {
    const { cover, document } = page((doc) => ({ coverTarget: () => doc.getElementById("card") }));
    cover.set(true);
    await frames();
    assert.equal(coverEl(document).style.width, "640px");
  });
});
