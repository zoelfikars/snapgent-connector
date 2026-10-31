// SPDX-License-Identifier: GPL-3.0-or-later
// The calibration dialog's panel and highlight: one closed shadow root of their own, so the page can neither see nor
// alter them. It only draws what it is told; the wizard decides what to say.

const STYLE = `
:host { all: initial; }
.card { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); width: min(480px, calc(100vw - 32px)); box-sizing: border-box;
  background: #17171c; color: #ececf1; border: 1px solid #facc15; border-radius: 12px; padding: 14px 16px; font: 14px/1.45 system-ui, sans-serif;
  box-shadow: 0 10px 40px rgba(0,0,0,.5); z-index: 2147483646; }
.head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.head b { color: #facc15; } .step { color: #9a9aa6; font-size: 12px; }
p { margin: 4px 0; } .hint { color: #9a9aa6; font-size: 12px; } .error { color: #f87171; }
pre { max-height: 180px; overflow: auto; background: #0e0e12; border-radius: 8px; padding: 8px; margin: 8px 0; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; border: 1px solid #3a3a45; color: #ececf1; font: 13px system-ui, sans-serif; }
button.primary { background: #facc15; color: #111; border-color: #facc15; font-weight: 600; } button:hover { filter: brightness(1.15); }
.mark { position: fixed; pointer-events: none; border: 2px dashed #60a5fa; border-radius: 4px; z-index: 2147483644; }
.mark.user { border-color: #4ade80; } .mark.user span { background: #4ade80; }
.mark.ai { border-color: #60a5fa; } .mark.ai span { background: #60a5fa; }
.mark.body { border-color: #e5e7eb; } .mark.body span { background: #e5e7eb; }
.mark.card { border: 2px solid #facc15; } .mark.card span { background: #facc15; color: #111; }
.mark span { position: absolute; top: -20px; left: -2px; background: #60a5fa; color: #0b1020; font: 600 11px system-ui, sans-serif; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
.outline { position: fixed; pointer-events: none; border: 2px solid #facc15; background: rgba(250,204,21,.12); border-radius: 4px; z-index: 2147483645; }
`;


/**
 * @param {{ document: Document, shadowMode: "open"|"closed", trusted?: (event: Event) => boolean, onAction: (action: string) => void }} deps
 */
export function createPanel({ document, shadowMode, trusted, onAction }) {
  let host = null;
  let shadow = null;

  function mount() {
    if (host) return;
    host = document.createElement("div");
    host.id = "zs-calibrate";
    shadow = host.attachShadow({ mode: shadowMode });
    shadow.innerHTML = `<style>${STYLE}</style><div class="card"><div class="head"><b></b><span class="step"></span></div><p class="text"></p><p class="hint"></p><pre hidden></pre><p class="error" hidden></p><div class="buttons"></div></div><div class="outline" hidden></div>`;
    (document.documentElement || document.body).appendChild(host);
  }
  const q = (selector) => shadow.querySelector(selector);

  /** @param {{ title: string, stepLabel?: string, text: string, hint?: string, preview?: string|null, error?: string, buttons?: Array<{ label: string, action: string, primary?: boolean }> }} view */
  function show({ title, stepLabel = "", text, hint = "", preview = null, error = "", buttons = [] }) {
    mount();
    q(".head b").textContent = title;
    q(".step").textContent = stepLabel;
    q(".text").textContent = text;
    setHint(hint);
    const pre = q("pre");
    pre.hidden = preview === null;
    pre.textContent = preview === null ? "" : preview;
    const err = q(".error");
    err.hidden = !error;
    err.textContent = error;
    const row = q(".buttons");
    row.textContent = "";
    for (const { label, action, primary } of buttons) {
      const button = document.createElement("button");
      button.textContent = label;
      button.dataset.action = action;
      if (primary) button.className = "primary";
      button.addEventListener("click", (event) => { if (event.isTrusted || trusted) onAction(action); });
      row.appendChild(button);
    }
  }

  function setHint(text) {
    if (!shadow) return;
    q(".hint").textContent = text;
    q(".hint").hidden = !text;
  }

  function highlight(el) {
    if (!shadow) return;
    const box = q(".outline");
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.hidden = false;
  }

  // What was already clicked stays on the page, labelled, so it is clear which element each step took.
  const marks = new Map(); // name -> { el, box }
  function placeMarks() {
    for (const { el, box } of marks.values()) {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.hidden = !el.isConnected || !r.width;
    }
  }
  function mark(name, el, label, kind = "pick") {
    if (!shadow) return;
    unmark(name);
    const box = document.createElement("div");
    box.className = `mark ${kind}`;
    box.innerHTML = "<span></span>";
    box.firstChild.textContent = label;
    shadow.appendChild(box);
    marks.set(name, { el, box });
    placeMarks();
  }
  function unmark(name) {
    const entry = marks.get(name);
    if (entry) { entry.box.remove(); marks.delete(name); }
  }
  function unmarkMatching(prefix) {
    for (const name of [...marks.keys()]) if (name.startsWith(prefix)) unmark(name);
  }
  const win = document.defaultView;
  const follow = () => placeMarks();
  win.addEventListener("scroll", follow, true);
  win.addEventListener("resize", follow);

  /** Whether `target` is part of the panel (a closed shadow root shows up as its host). */
  const owns = (target) => !!host && (target === host || host.contains(target));
  function remove() {
    marks.clear();
    win.removeEventListener("scroll", follow, true);
    win.removeEventListener("resize", follow);
    if (host) { host.remove(); host = null; shadow = null; }
  }

  return { show, setHint, highlight, mark, unmark, unmarkMatching, owns, remove, root: () => shadow, isOpen: () => !!host };
}
