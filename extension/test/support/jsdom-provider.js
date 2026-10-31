// Small helpers for tests that need a real DOM (jsdom) with the layout-dependent bits stubbed.
import { JSDOM } from "jsdom";

/**
 * A page where everything counts as laid out unless it is hidden (`hidden` attribute or a `hidden` class on it or an
 * ancestor): jsdom has no layout engine. Clipboard and input events are given just enough shape for editors to receive.
 */
export function pageWith(html, url = "https://example.test/") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const { window } = dom;
  const hiddenAbove = (el) => !el.isConnected || !!el.closest("[hidden], .hidden");
  window.Element.prototype.getClientRects = function () { return hiddenAbove(this) ? [] : [{ width: 100, height: 20 }]; };
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return hiddenAbove(this) ? null : this.ownerDocument.body; } });
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; };
  window.DataTransfer = class { constructor() { this.data = {}; } setData(type, value) { this.data[type] = value; } getData(type) { return this.data[type] || ""; } };
  window.ClipboardEvent = class extends window.Event { constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData; } };
  window.InputEvent = window.InputEvent || class extends window.Event { constructor(type, init = {}) { super(type, init); Object.assign(this, init); } };
  return { window, document: window.document };
}
