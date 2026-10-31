// SPDX-License-Identifier: GPL-3.0-or-later
// The calibration dialog: the user clicks the text box, the send button, a reply and a message of their own; the extension
// shows what it would read from the reply, checks that it can write into the text box (nothing is sent), and saves the
// profile. It can also redo a single part. Panel and highlight live in a closed shadow root of their own so the page
// cannot see or alter them; only genuine clicks pick anything (picker.js).

import { createPicker } from "./picker.js";

const EDITABLE = 'textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const CLICKABLE = "button, [role=button], a, input[type=submit]";
const FLOWS = { all: ["composer", "send", "reply", "message"], composer: ["composer"], send: ["send"], reply: ["reply", "message"] };
const PREVIEW_CHARS = 700;

const STEPS = {
  composer: {
    text: "Click the text box where you type your message.",
    refine: (el) => el.closest(EDITABLE) || el,
    accept: (el) => (el.matches(EDITABLE) ? null : "That does not look like a text box. Click inside the box where you type."),
  },
  send: {
    text: "Click the send button.",
    hint: "If this site has no send button (you press Enter), choose “Enter sends”.",
    refine: (el) => el.closest(CLICKABLE) || el,
  },
  reply: {
    text: "Click any reply from the AI (anywhere on it).",
    hint: "This needs a chat with at least one message of yours and one reply. In an empty chat, cancel, send a message, then calibrate.",
  },
  message: {
    text: "Now click one of YOUR messages in the same chat.",
    accept: (el, picks) => (picks.reply && (picks.reply === el || picks.reply.contains(el) || el.contains(picks.reply)) ? "That is part of the reply. Click one of your own messages." : null),
  },
  answer: { text: "Click just the part of the reply that is the answer." },
};

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
.outline { position: fixed; pointer-events: none; border: 2px solid #facc15; background: rgba(250,204,21,.12); border-radius: 4px; z-index: 2147483645; }
`;

/**
 * @param {{ document: Document, hostname: string, name: string, current: object|null,
 *           calibration: { learnProfile: Function, updateProfile: Function, createProvider: (profile: object) => object },
 *           onSave: (profile: object) => Promise<{ ok: boolean, error?: string }>, onClose?: () => void,
 *           shadowMode?: "open"|"closed", trusted?: (event: Event) => boolean }} deps
 */
export function createCalibrationWizard({ document, hostname, name, current, calibration, onSave, onClose = () => {}, shadowMode = "closed", trusted }) {
  const picker = createPicker({ document, trusted });
  let host = null;
  let shadow = null;
  let stopPicking = () => {};
  let flow = null;       // "all" | "composer" | "send" | "reply"
  let steps = [];
  let index = 0;
  let picks = {};
  let draft = null;
  let step = null;       // the step name being shown
  let error = "";
  let done = false;

  // ── panel ──────────────────────────────────────────────────────────────────
  function mount() {
    if (host) return;
    host = document.createElement("div");
    host.id = "zs-calibrate";
    shadow = host.attachShadow({ mode: shadowMode });
    shadow.innerHTML = `<style>${STYLE}</style><div class="card"><div class="head"><b></b><span class="step"></span></div><p class="text"></p><p class="hint"></p><pre hidden></pre><p class="error" hidden></p><div class="buttons"></div></div><div class="outline" hidden></div>`;
    (document.documentElement || document.body).appendChild(host);
  }
  const q = (selector) => shadow.querySelector(selector);

  function render({ text, hint = "", preview = null, buttons = [] }) {
    mount();
    q(".head b").textContent = `Calibrate ${name}`;
    q(".step").textContent = done ? "" : flow && steps.length > 1 ? `Step ${Math.min(index + 1, steps.length)} of ${steps.length}` : "";
    q(".text").textContent = text;
    q(".hint").textContent = hint;
    q(".hint").hidden = !hint;
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
      button.addEventListener("click", (event) => { if (event.isTrusted || trusted) handle(action); });
      row.appendChild(button);
    }
  }

  function highlight(el) {
    const box = q(".outline");
    if (!box) return;
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.hidden = false;
  }

  // ── steps ──────────────────────────────────────────────────────────────────
  function pickStep(name_) {
    stopPicking();
    step = name_;
    const def = STEPS[name_];
    const buttons = [{ label: "Cancel", action: "cancel" }];
    if (name_ === "send") buttons.unshift({ label: "Enter sends", action: "enter-sends" });
    if (index > 0 && name_ !== "answer") buttons.unshift({ label: "Back", action: "back" });
    render({ text: def.text, hint: def.hint || "", buttons });
    stopPicking = picker.start({
      // our own panel and the control bar are not part of the page being taught
      ignore: (target) => target === host || host.contains(target) || !!(target.closest && target.closest("#zs-root")),
      refine: def.refine,
      onHover: highlight,
      onPick: (el) => {
        const problem = def.accept ? def.accept(el, picks) : null;
        if (problem) { error = problem; render({ text: def.text, hint: def.hint || "", buttons }); return; }
        error = "";
        if (name_ === "answer") { picks.assistantInner = el; relearn(); return; }
        picks[name_] = el;
        advance();
      },
      onCancel: () => cancel(),
    });
  }

  function advance() {
    index += 1;
    if (index < steps.length) { pickStep(steps[index]); return; }
    relearn();
  }

  function relearn() {
    stopPicking();
    let learned;
    const forReply = { assistant: picks.reply, user: picks.message, assistantInner: picks.assistantInner || null };
    if (flow === "all") {
      learned = calibration.learnProfile({ hostname, name, picks: { composer: picks.composer, send: picks.send || null, ...forReply } });
    } else if (flow === "reply") learned = calibration.updateProfile(current, "reply", forReply);
    else learned = calibration.updateProfile(current, flow, { [flow]: picks[flow] });
    if (learned.error) {
      error = learned.error;
      const back = /reply|message/i.test(learned.error) ? steps.indexOf("reply") : 0;
      index = Math.max(0, back);
      pickStep(steps[index]);
      return;
    }
    draft = learned.profile;
    error = learned.warnings.join(" ");
    if (flow === "all" || flow === "reply") preview(); else check();
  }

  function preview() {
    step = "preview";
    const provider = calibration.createProvider(draft);
    const read = (provider.readAssistant().reply || "").trim();
    const shown = read.length > PREVIEW_CHARS ? `${read.slice(0, PREVIEW_CHARS)}…` : read;
    if (!read) error = error || "Nothing was read from the reply.";
    render({
      text: "This is what will be read from the AI's last reply. Is that the answer, without labels or buttons?",
      preview: shown || "(nothing)",
      buttons: [
        { label: "Looks right", action: "looks-right", primary: !!read },
        { label: "Pick just the answer", action: "pick-answer" },
        { label: "Redo the reply", action: "redo-reply" },
        { label: "Cancel", action: "cancel" },
      ],
    });
  }

  async function check() {
    step = "check";
    const provider = calibration.createProvider(draft);
    if (flow === "all" || flow === "composer") {
      render({ text: "Checking that the text box takes text. Nothing is sent…" });
      const result = await provider.testWrite();
      if (!result.ok) {
        error = `The text box did not take the test text (${result.error}).`;
        render({ text: "The text box could not be written to.", buttons: [{ label: "Redo the text box", action: "redo-composer", primary: true }, { label: "Save anyway", action: "save" }, { label: "Cancel", action: "cancel" }] });
        return;
      }
    }
    await save();
  }

  async function save() {
    step = "save";
    const result = await onSave(draft);
    if (!result.ok) {
      error = result.error || "Could not save.";
      render({ text: "Could not save the calibration.", buttons: [{ label: "Try again", action: "save", primary: true }, { label: "Cancel", action: "cancel" }] });
      return;
    }
    done = true;
    error = "";
    step = "done";
    render({ text: `${name} is calibrated. You can press Start.`, buttons: [{ label: "Close", action: "close", primary: true }] });
  }

  function handle(action) {
    if (action === "cancel" || action === "close") { cancel(); return; }
    if (action === "back") { index = Math.max(0, index - 1); error = ""; pickStep(steps[index]); return; }
    if (action === "enter-sends") { picks.send = null; error = ""; advance(); return; }
    if (action === "looks-right") { check(); return; }
    if (action === "pick-answer") { error = ""; pickStep("answer"); return; }
    if (action === "redo-reply") { index = steps.indexOf("reply"); error = ""; pickStep("reply"); return; }
    if (action === "redo-composer") { flow = "composer"; steps = ["composer"]; index = 0; error = ""; pickStep("composer"); return; }
    if (action === "save") { save(); return; }
  }

  // ── public ─────────────────────────────────────────────────────────────────
  /** @param {{ only?: "composer"|"send"|"reply"|null }} [options] only: redo one part of an existing profile. */
  function start({ only = null } = {}) {
    cancel(false);
    flow = only && current ? only : "all";
    steps = [...FLOWS[flow]];
    index = 0; picks = {}; draft = null; error = ""; done = false;
    pickStep(steps[0]);
  }

  function cancel(notify = true) {
    stopPicking();
    stopPicking = () => {};
    if (host) { host.remove(); host = null; shadow = null; }
    if (notify) onClose();
  }

  return { start, cancel, state: () => ({ step, error, done, open: !!host, flow }), panel: () => shadow };
}
