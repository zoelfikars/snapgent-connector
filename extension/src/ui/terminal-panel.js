// SPDX-License-Identifier: GPL-3.0-or-later
// The terminal panel: one overlay in the corner of the page with a tab per command (running ones
// first), the output of the selected tab drawn by page/terminal.js into the body it owns, and an
// input where the user types a command by hand (for when the agent was interrupted midway).
// Pure drawing: the tabs' data comes in, clicks and typed text go out through the callbacks.

import { lineHtml } from "./ansi.js";

const MAX_BODY_LINES = 2000; // per tab; the oldest are dropped
const DEFAULT_HINT = "Ctrl+Enter runs the command · Copy gives what the AI would receive";

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TEMPLATE = `
  <div id="zs-term" hidden role="dialog" aria-label="Terminal">
    <div class="zs-t-head">
      <span class="zs-t-title">Terminal</span>
      <span class="zs-t-note">commands of this chat</span>
      <button type="button" class="zs-t-close" aria-label="Close the terminal">&#10005;</button>
    </div>
    <div class="zs-t-tabs" role="tablist"></div>
    <div class="zs-t-body"></div>
    <div class="zs-t-entry">
      <textarea class="zs-t-input" rows="2" spellcheck="false" aria-label="Command to run" placeholder='{"command":"git_status","params":{}}'></textarea>
      <button type="button" class="zs-t-run" title="Run (Ctrl+Enter)">Run</button>
    </div>
    <div class="zs-t-foot"><span class="zs-t-hint"></span>
    <button type="button" class="zs-t-examples" title="Example commands you can copy">Examples</button>
    <button type="button" class="zs-t-copy" hidden title="Copy the output of the selected command">Copy</button>
    <button type="button" class="zs-t-stop" hidden>■ Stop</button></div>
    <div class="zs-t-grip" title="Drag to resize" aria-hidden="true"></div>
  </div>`;

/**
 * @param {{ document: Document, onStop?: (key: string) => void, onCopy?: (key: string) => void,
 *           onRun?: (text: string) => ({ ok: boolean, error?: string } | void) }} deps
 *   Stop and Copy act on the selected tab; `onRun` gets the typed text and says whether it was accepted.
 * @returns {{ root: HTMLElement, open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean,
 *             setTabs: (tabs: object[]) => void, appendLine: (key: string, segments: object[]) => void,
 *             select: (key: string) => void, forget: (key: string) => void, flashCopy: (ok: boolean) => void }}
 */
export function createTerminalPanel({ document, onStop = () => {}, onCopy = () => {}, onRun = () => ({ ok: true }), onExamples = () => {} }) {
  const root = document.createElement("div");
  root.innerHTML = TEMPLATE;
  const panel = root.firstElementChild;
  document.documentElement.appendChild(panel);
  const tabsEl = panel.querySelector(".zs-t-tabs");
  const bodyEl = panel.querySelector(".zs-t-body");
  const stopEl = panel.querySelector(".zs-t-stop");
  const copyEl = panel.querySelector(".zs-t-copy");
  const inputEl = panel.querySelector(".zs-t-input");
  const runEl = panel.querySelector(".zs-t-run");
  const hintEl = panel.querySelector(".zs-t-hint");
  const bodies = new Map(); // tab key -> { el, count }

  // The panel is anchored at the top-right, so its bottom-left grip is the only corner that can grow
  // in both directions: left widens it, down makes it taller. Never larger than the window.
  const gripEl = panel.querySelector(".zs-t-grip");
  const MIN_W = 320;
  const MIN_H = 200;
  let drag = null;
  gripEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, w: rect.width, h: rect.height };
    if (gripEl.setPointerCapture) gripEl.setPointerCapture(event.pointerId);
    panel.classList.add("zs-t-resizing");
  });
  gripEl.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const view = document.documentElement;
    const width = Math.min(view.clientWidth - 28, Math.max(MIN_W, drag.w + (drag.x - event.clientX)));
    const height = Math.min(view.clientHeight - 28, Math.max(MIN_H, drag.h + (event.clientY - drag.y)));
    panel.style.width = `${Math.round(width)}px`;
    panel.style.height = `${Math.round(height)}px`;
  });
  const endDrag = () => { drag = null; panel.classList.remove("zs-t-resizing"); };
  gripEl.addEventListener("pointerup", endDrag);
  gripEl.addEventListener("pointercancel", endDrag);
  let selected = null;
  let copyTimer = null;

  panel.querySelector(".zs-t-close").addEventListener("click", () => close());
  stopEl.addEventListener("click", () => { if (selected) onStop(selected); });
  copyEl.addEventListener("click", () => { if (selected) onCopy(selected); });
  runEl.addEventListener("click", () => submit());
  panel.querySelector(".zs-t-examples").addEventListener("click", () => onExamples());
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  });
  // The site's shortcuts must not fire while typing here, whichever key event they listen to.
  for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, (event) => event.stopPropagation());
  setHint();

  /** The line under the output: the usual hint, or why the typed text was refused. */
  function setHint(text = "", bad = false) {
    hintEl.textContent = text || DEFAULT_HINT;
    hintEl.title = text || "";
    hintEl.classList.toggle("zs-t-bad", !!text && bad);
  }

  /** The typed text is kept when it is refused, so a typo can be fixed instead of retyped. */
  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    const verdict = onRun(text) || { ok: true };
    if (verdict.ok) { inputEl.value = ""; setHint(); } else setHint(verdict.error || "That was not run.", true);
  }

  /** The Copy button says how it went for a moment. */
  function flashCopy(ok) {
    copyEl.textContent = ok ? "Copied ✓" : "Copy failed";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyEl.textContent = "Copy"; }, 1500);
  }

  /** Text for the input (an example command), ready to edit and run. */
  function setInput(text) {
    inputEl.value = text;
    setHint();
    inputEl.focus();
  }

  function open() { panel.hidden = false; }
  function close() { panel.hidden = true; }
  function toggle() { panel.hidden ? open() : close(); }
  function isOpen() { return !panel.hidden; }

  /** One pill in the tab row. */
  function setTabs(tabs) {
    tabsEl.innerHTML = tabs.map((tab) => {
      const marker = tab.status === "running" ? "●" : tab.status === "success" ? "✓" : tab.status === "stopped" ? "⏹" : "✕";
      return `<button type="button" class="zs-t-tab zs-t-${tab.status}${tab.key === selected ? " zs-t-sel" : ""}" data-key="${escapeHtml(tab.key)}" role="tab">` +
        `<span class="zs-t-dot">${marker}</span><span class="zs-t-name">${escapeHtml(tab.name)}</span></button>`;
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
    const tab = [...tabsEl.querySelectorAll(".zs-t-tab")].find((el) => el.dataset.key === key);
    const running = !!(tab && tab.classList.contains("zs-t-running"));
    stopEl.hidden = !running;
    copyEl.hidden = !tab;
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

  /** A tab that was dropped from the list takes its scrollback with it. */
  function forget(key) {
    const tab = bodies.get(key);
    if (!tab) return;
    tab.el.remove();
    bodies.delete(key);
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

  return { root: panel, open, close, toggle, isOpen, setTabs, appendLine, select, forget, flashCopy, setInput };
}
