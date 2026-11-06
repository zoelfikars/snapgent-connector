// SPDX-License-Identifier: GPL-3.0-or-later
// The terminal panel: one overlay in the corner of the page with a tab per command (running ones
// first), and the output of the selected tab drawn by page/terminal.js into the body it owns.
// Pure drawing: the tabs' data comes in, clicks go out through the callbacks.

import { lineHtml } from "./ansi.js";

const MAX_BODY_LINES = 2000; // per tab; the oldest are dropped

const TEMPLATE = `
  <div id="zs-term" hidden role="dialog" aria-label="Terminal">
    <div class="zs-t-head">
      <span class="zs-t-title">Terminal</span>
      <span class="zs-t-note">commands of this chat</span>
      <button type="button" class="zs-t-close" aria-label="Close the terminal">&#10005;</button>
    </div>
    <div class="zs-t-tabs" role="tablist"></div>
    <div class="zs-t-body"></div>
    <div class="zs-t-foot"><span class="zs-t-hint">input is off: a command that asks for an answer waits anyway</span>
    <button type="button" class="zs-t-stop" hidden>■ Stop</button></div>
  </div>`;

/**
 * @param {{ document: Document, onStop?: (key: string) => void }} deps  Stop on the selected tab.
 * @returns {{ root: HTMLElement, open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean,
 *             setTabs: (tabs: object[]) => void, appendLine: (key: string, segments: object[]) => void,
 *             select: (key: string) => void }}
 */
export function createTerminalPanel({ document, onStop = () => {} }) {
  const root = document.createElement("div");
  root.innerHTML = TEMPLATE;
  const panel = root.firstElementChild;
  document.documentElement.appendChild(panel);
  const tabsEl = panel.querySelector(".zs-t-tabs");
  const bodyEl = panel.querySelector(".zs-t-body");
  const stopEl = panel.querySelector(".zs-t-stop");
  const bodies = new Map(); // tab key -> { el, count }
  let selected = null;

  panel.querySelector(".zs-t-close").addEventListener("click", () => close());
  stopEl.addEventListener("click", () => { if (selected) onStop(selected); });
  panel.addEventListener("keydown", (event) => event.stopPropagation()); // the site's shortcuts must not fire while typing here

  function open() { panel.hidden = false; }
  function close() { panel.hidden = true; }
  function toggle() { panel.hidden ? open() : close(); }
  function isOpen() { return !panel.hidden; }

  /** One pill in the tab row. */
  function setTabs(tabs) {
    tabsEl.innerHTML = tabs.map((tab) => {
      const marker = tab.status === "running" ? "●" : tab.status === "success" ? "✓" : tab.status === "stopped" ? "⏹" : "✕";
      return `<button type="button" class="zs-t-tab zs-t-${tab.status}${tab.key === selected ? " zs-t-sel" : ""}" data-key="${tab.key}" role="tab">` +
        `<span class="zs-t-dot">${marker}</span><span class="zs-t-name">${tab.name}</span></button>`;
    }).join("") || '<span class="zs-t-empty">No command has run yet.</span>';
    for (const el of tabsEl.querySelectorAll(".zs-t-tab")) {
      el.addEventListener("click", () => select(el.dataset.key));
    }
    // The row is rebuilt on every change: re-apply the selection, so Stop follows the tab's status.
    if (selected) select(selected);
  }

  function select(key) {
    selected = key;
    bodyEl.querySelectorAll(".zs-t-term").forEach((el) => { el.hidden = el.dataset.key !== key; });
    tabsEl.querySelectorAll(".zs-t-tab").forEach((el) => el.classList.toggle("zs-t-sel", el.dataset.key === key));
    const tab = tabsEl.querySelector(`.zs-t-tab[data-key="${key}"]`);
    const running = !!(tab && tab.classList.contains("zs-t-running"));
    stopEl.hidden = !running;
    scrollToEnd(key);
  }

  /** The tab's own scrollback element, made on first use. */
  function body(key) {
    let tab = bodies.get(key);
    if (!tab) {
      const el = document.createElement("div");
      el.className = "zs-t-term";
      el.dataset.key = key;
      el.hidden = key !== selected;
      bodyEl.appendChild(el);
      tab = { el, count: 0 };
      bodies.set(key, tab);
    }
    return tab;
  }

  function appendLine(key, segments) {
    const tab = body(key);
    tab.count += 1;
    tab.el.insertAdjacentHTML("beforeend", lineHtml(segments));
    // Drop the oldest, one line at a time, so a spewing command stays bounded.
    if (tab.count > MAX_BODY_LINES && tab.el.firstElementChild) {
      tab.el.firstElementChild.remove();
      tab.count -= 1;
    }
    scrollToEnd(key);
  }

  /** Followed only while the reader is near the bottom: reading old output must not be yanked away. */
  function scrollToEnd(key) {
    const { el } = body(key);
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  return { root: panel, open, close, toggle, isOpen, setTabs, appendLine, select };
}
