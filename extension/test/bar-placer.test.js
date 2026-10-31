import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createBarPlacer } from "../src/ui/bar-placer.js";

// jsdom has no layout, so every element gets a fixed box; what is under test is which mode is chosen and the DOM work for it.
function page(providerOver = () => ({})) {
  const dom = new JSDOM(`<body>
    <div id="zs-root"><div id="bar"></div><div id="menu" hidden></div><div id="unstable" hidden></div></div>
    <form id="composer"><div id="mount"><div id="before"></div></div><div id="editor"></div></form>
  </body>`, { url: "https://example.test/" });
  const { window } = dom;
  const { document } = window;
  const rect = { left: 100, top: 400, width: 600, height: 40, right: 700, bottom: 440 };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return rect; };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { get() { return 34; }, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200 });
  Object.defineProperty(window, "innerHeight", { value: 800 });
  const parts = { bar: document.getElementById("bar"), root: document.getElementById("zs-root"), menuEl: document.getElementById("menu"), unstableEl: document.getElementById("unstable") };
  const menuAnchors = [];
  const provider = { getEditor: () => document.getElementById("editor"), ...providerOver(document) };
  const placer = createBarPlacer({ document, provider, parts: () => parts, positionMenu: (anchor) => menuAnchors.push(anchor) });
  return { document, parts, placer, provider, menuAnchors, window };
}

describe("bar placer", () => {
  test("before the bar exists there is nothing to place and nothing throws", () => {
    const { placer, parts } = page();
    parts.bar = null;
    assert.doesNotThrow(() => placer.place());
  });

  test("with no mount and no anchor it floats above the editor inside our own root", () => {
    const { placer, parts } = page();
    placer.place();
    assert.equal(parts.bar.style.display, "flex");
    assert.equal(parts.bar.parentElement, parts.root);
    assert.ok(parts.bar.style.width && parts.bar.style.left && parts.bar.style.top, "geometry applied");
    assert.equal(parts.bar.classList.contains("zs-bar-inline"), false);
  });

  test("floating hides the bar when the page has no editor", () => {
    const { placer, parts } = page(() => ({ getEditor: () => null }));
    placer.place();
    assert.equal(parts.bar.style.display, "none");
  });

  test("a provider mount seats the bar inside the composer, before the node it names", () => {
    const { placer, parts, document } = page((doc) => ({ barMount: () => ({ parent: doc.getElementById("mount"), before: doc.getElementById("before"), inside: true }) }));
    placer.place();
    assert.equal(parts.bar.parentElement, document.getElementById("mount"));
    assert.equal(parts.bar.nextElementSibling, document.getElementById("before"));
    assert.ok(parts.bar.classList.contains("zs-bar-inline") && parts.bar.classList.contains("zs-bar-inside"));
    assert.equal(parts.bar.style.display, "flex");
  });

  test("placing again does not move or re-insert an already seated bar", () => {
    const { placer, parts } = page((doc) => ({ barMount: () => ({ parent: doc.getElementById("mount"), before: doc.getElementById("before") }) }));
    placer.place();
    let moves = 0;
    new parts.bar.ownerDocument.defaultView.MutationObserver(() => { moves++; }).observe(parts.bar.parentElement, { childList: true });
    placer.place();
    return new Promise((resolve) => setTimeout(() => { assert.equal(moves, 0); resolve(); }, 10));
  });

  test("a mount that is not connected is ignored and the bar floats instead", () => {
    const { placer, parts, document } = page((doc) => ({ barMount: () => ({ parent: doc.createElement("div") }) }));
    placer.place();
    assert.equal(parts.bar.parentElement, parts.root);
    assert.equal(document.querySelector(".zs-bar-inline"), null);
  });

  test("leaving the inline mount takes the bar back into our root and drops the inline look", () => {
    let mounted = true;
    const { placer, parts } = page((doc) => ({ barMount: () => (mounted ? { parent: doc.getElementById("mount"), before: null, inside: false } : null) }));
    placer.place();
    mounted = false;
    placer.place();
    assert.equal(parts.bar.parentElement, parts.root);
    assert.equal(parts.bar.classList.contains("zs-bar-inline"), false);
  });

  test("anchored: the bar stays in our root and the strip it needs is reserved as padding on the composer", () => {
    const { placer, parts, document } = page((doc) => ({ barAnchor: () => doc.getElementById("composer") }));
    placer.place();
    const composer = document.getElementById("composer");
    assert.ok(parts.bar.classList.contains("zs-bar-anchored"));
    assert.equal(parts.bar.parentElement, parts.root);
    assert.match(composer.style.paddingTop, /px$/);
  });

  test("leaving the anchored mode gives the composer its own padding back", () => {
    let obstructed = false;
    const { placer, document } = page((doc) => ({ barAnchor: () => doc.getElementById("composer"), overlayBlocking: () => obstructed }));
    placer.place();
    assert.notEqual(document.getElementById("composer").style.paddingTop, "");
    obstructed = true;
    placer.place();
    assert.equal(document.getElementById("composer").style.paddingTop, "");
  });

  test("a captcha or a blocking dialog hides the bar and its open menu so they cannot swallow clicks", () => {
    for (const key of ["captchaPresent", "overlayBlocking"]) {
      const { placer, parts } = page(() => ({ [key]: () => true }));
      parts.menuEl.hidden = false;
      placer.place();
      assert.equal(parts.bar.style.display, "none", key);
      assert.equal(parts.menuEl.hidden, true, key);
    }
  });

  test("an open menu follows the bar", () => {
    const { placer, parts, menuAnchors } = page();
    parts.menuEl.hidden = false;
    placer.place();
    assert.equal(menuAnchors.length, 1);
  });

  test("the unstable pill sits above the visible bar and hides with it", () => {
    let obstructed = false;
    const { placer, parts } = page(() => ({ overlayBlocking: () => obstructed }));
    placer.place();
    assert.equal(parts.unstableEl.hidden, false);
    assert.ok(parts.unstableEl.style.left && parts.unstableEl.style.top);
    obstructed = true;
    placer.place(); // the pill follows the bar's state from the previous frame
    placer.place();
    assert.equal(parts.unstableEl.hidden, true);
  });

  test("if the site detached our root, it is put back", () => {
    const { placer, parts, document } = page();
    parts.root.remove();
    placer.place();
    assert.equal(parts.root.isConnected, true);
    assert.equal(parts.root.parentElement, document.documentElement);
  });
});
