// Small helpers for tests that need a real DOM (jsdom) with the layout-dependent bits stubbed.
import { JSDOM } from "jsdom";

/** A page whose elements all count as laid out (jsdom has no layout engine). */
export function pageWith(html, url = "https://example.test/") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return this.isConnected ? this.ownerDocument.body : null; } });
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; };
  return { window, document: window.document };
}
