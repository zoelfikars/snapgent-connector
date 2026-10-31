// SPDX-License-Identifier: GPL-3.0-or-later
// The calibration dialog: the user clicks the text box, the send button, a reply and a message of their own; the extension
// shows what it would read from the reply, checks that it can write into the text box (nothing is sent), and saves the
// profile. It can also redo a single part. Panel and highlight live in a closed shadow root of their own so the page
// cannot see or alter them; only genuine clicks pick anything (picker.js).

import { createPanel } from "./calibration-panel.js";
import { FLOWS, MARK_LABELS, STEPS } from "./calibration-steps.js";
import { reviewOf } from "./calibration-review.js";
import { createPicker } from "./picker.js";

async function defaultCopy(text) {
  await navigator.clipboard.writeText(text);
}

/**
 * @param {{ document: Document, hostname: string, name: string, current: object|null,
 *           calibration: { learnProfile: Function, updateProfile: Function, createProvider: (profile: object) => object },
 *           onSave: (profile: object) => Promise<{ ok: boolean, error?: string }>, onClose?: () => void,
 *           describe?: (el: Element) => string, copy?: (text: string) => Promise<void>,
 *           shadowMode?: "open"|"closed", trusted?: (event: Event) => boolean }} deps
 *   `describe` renders an element as its tag and stable attributes (never its text) for the report; `copy` puts text on the clipboard.
 */
export function createCalibrationWizard({
  document, hostname, name, current, calibration, onSave, onClose = () => {}, describe = (el) => el.localName, copy = defaultCopy, shadowMode = "closed", trusted,
}) {
  const picker = createPicker({ document, trusted });
  const panel = createPanel({ document, shadowMode, trusted, onAction: (action) => handle(action) });
  let stopPicking = () => {};
  let flow = null;       // "all" | "composer" | "send" | "reply"
  let steps = [];
  let index = 0;
  let picks = {};
  let draft = null;
  let step = null;       // the step name being shown
  let error = "";
  let done = false;

  function render({ text, hint = "", preview = null, buttons = [] }) {
    const withReport = (error || step === "preview") && !done ? [...buttons, { label: "Copy report", action: "copy-report" }] : buttons;
    const stepLabel = done ? "" : flow && steps.length > 1 ? `Step ${Math.min(index + 1, steps.length)} of ${steps.length}` : "";
    panel.show({ title: `Calibrate ${name}`, stepLabel, text, hint, preview, error, buttons: withReport });
  }

  // ── steps ──────────────────────────────────────────────────────────────────
  function pickStep(name_) {
    stopPicking();
    step = name_;
    const def = STEPS[name_];
    const buttons = [{ label: "Cancel", action: "cancel" }];
    if (name_ === "send") buttons.unshift({ label: "Enter sends", action: "enter-sends" });
    if (index > 0 && name_ !== "answer" && name_ !== "card") buttons.unshift({ label: "Back", action: "back" });
    render({ text: def.text, hint: def.hint || "", buttons });
    stopPicking = picker.start({
      // our own panel and the control bar are not part of the page being taught
      ignore: (target) => panel.owns(target) || !!(target.closest && target.closest("#zs-root")),
      refine: def.refine,
      onHover: panel.highlight,
      onPick: (el) => {
        const problem = def.accept ? def.accept(el, picks) : null;
        if (problem) { error = problem; render({ text: def.text, hint: def.hint || "", buttons }); return; }
        error = "";
        if (name_ === "card") { picks.card = el; const u = calibration.updateProfile(draft, "card", { card: el }); if (u.error) { error = u.error; render({ text: def.text, hint: def.hint || "", buttons }); return; } draft = u.profile; error = ""; preview(); return; }
        if (name_ === "answer") { picks.assistantInner = el; panel.mark("answer", el, MARK_LABELS.answer); relearn(); return; }
        picks[name_] = el;
        panel.mark(name_, el, MARK_LABELS[name_]);
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
    } else if (flow === "reply") {
      const known = calibration.createProvider(current).review(); // a turn is never the text box or around it
      learned = calibration.updateProfile(current, "reply", { ...forReply, keepOut: [known.composer, known.send].filter(Boolean) });
    }
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
    panel.unmarkMatching("rv:");
    const review = reviewOf(calibration.createProvider(draft));
    for (const m of review.marks) panel.mark(m.name, m.el, m.label, m.kind);
    if (review.warnings.length) error = [error, ...review.warnings].filter(Boolean).join(" ");
    render({
      text: "Look at the page: green boxes should be your messages, blue boxes the AI replies, “Read from here” the answer.",
      preview: review.text,
      buttons: [
        { label: "Looks right", action: "looks-right", primary: !!review.read && !review.warnings.length },
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
    render({ text: `${name} is calibrated. Open a new chat and press Start there.`, buttons: [{ label: "Close", action: "close", primary: true }] });
  }

  // What a bug report needs and nothing private: where the clicks landed (tag and stable attributes of the element and what is
  // around it), the profile learned, and what went wrong. No text of the conversation is included.
  function report() {
    const chain = (el) => {
      const lines = [];
      for (let n = el; n && n.nodeType === 1 && lines.length < 8; n = n.parentElement) lines.push(`    ${describe(n)}`);
      return lines.join("\n");
    };
    const picked = Object.entries(picks).filter(([, el]) => el && el.nodeType === 1).map(([role, el]) => `  ${role}:\n${chain(el)}`);
    // Where things sit on screen, to tell a wrong box from a right one without a screenshot: sizes only, no text.
    const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    const found = [];
    if (draft) {
      try {
        const info = calibration.createProvider(draft).review();
        for (const [role, el] of [["composer", info.composer], ["card (bar's box)", info.card], ["body (read from)", info.body]]) {
          if (el) found.push(`  ${role}: ${rect(el)}\n${chain(el)}`);
        }
        found.push(`  turns: ${info.users.length} yours, ${info.assistants.length} AI; code blocks ${info.codeBlocksRead}/${info.codeBlocks} read`);
      } catch (e) { found.push(`  (review failed: ${e.message})`); }
    }
    return [
      "snapgent calibration report", `site: ${hostname} (${name})`, `step: ${step || "-"}`, `error: ${error || "-"}`,
      `profile: ${draft ? JSON.stringify(draft) : "-"}`, "clicks (innermost first):", ...(picked.length ? picked : ["  -"]), "found on the page:", ...(found.length ? found : ["  -"]),
    ].join("\n");
  }

  async function handle(action) {
    if (action === "copy-report") {
      try { await copy(report()); panel.setHint("Report copied. Paste it where you report the problem."); }
      catch { panel.setHint("Could not copy the report to the clipboard."); }
      return;
    }
    if (action === "cancel" || action === "close") { cancel(); return; }
    if (action === "back") { index = Math.max(0, index - 1); panel.unmark(steps[index]); error = ""; pickStep(steps[index]); return; }
    if (action === "enter-sends") { picks.send = null; error = ""; advance(); return; }
    if (action === "looks-right") { panel.unmarkMatching("rv:"); check(); return; }
    if (action === "pick-card") { error = ""; panel.unmarkMatching("rv:"); pickStep("card"); return; }
    if (action === "pick-answer") { error = ""; pickStep("answer"); return; }
    if (action === "redo-reply") { for (const name_ of ["reply", "message", "answer"]) panel.unmark(name_); picks.assistantInner = null; index = steps.indexOf("reply"); error = ""; pickStep("reply"); return; }
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
    panel.unmarkMatching("rv:");
    panel.remove();
    if (notify) onClose();
  }

  return { start, cancel, state: () => ({ step, error, done, open: panel.isOpen(), flow }), panel: () => panel.root() };
}
