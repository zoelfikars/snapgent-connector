// SPDX-License-Identifier: GPL-3.0-or-later
// What the calibration dialog asks for, in order, and what counts as an acceptable click at each step.

export const EDITABLE = 'textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const CLICKABLE = "button, [role=button], a, input[type=submit]";
export const FLOWS = { all: ["composer", "send", "reply", "message"], composer: ["composer"], send: ["send"], reply: ["reply", "message"] };
export const PREVIEW_CHARS = 700;

const shown = (el) => el.getClientRects().length > 0;

/**
 * The text field that a click on or around it means: the field itself or the one it sits in; or, when the click landed on
 * the box that holds the field (its card, a wrapper), the one field inside it. Looked for a few levels up so a click
 * on the padding or an attached button's neighbour still finds it. Null when there is no single obvious field.
 */
export function resolveEditable(el) {
  const own = el.closest(EDITABLE);
  if (own) return own;
  for (let n = el, level = 0; n && n.nodeType === 1 && level < 4; n = n.parentElement, level++) {
    const inside = [...n.querySelectorAll(EDITABLE)].filter(shown);
    if (inside.length === 1) return inside[0];
    if (inside.length > 1) return null;
  }
  return null;
}

export const STEPS = {
  composer: {
    text: "Click inside the text box where you type your message to the AI.",
    refine: (el) => resolveEditable(el) || el,
    accept: (el) => (el.matches(EDITABLE) ? null : "No text field was found there. Click inside the box where you type."),
  },
  send: {
    text: "Click the send button (the arrow or paper plane you press to send).",
    hint: "No button, or it only shows once you have typed something? Choose “Enter sends”.",
    refine: (el) => el.closest(CLICKABLE) || el,
  },
  reply: {
    text: "Click on the WORDS of a reply written by the AI (not a button, not the empty space around it).",
    hint: "This needs a chat with at least one message of yours and one reply. In an empty chat, cancel, send a message, then calibrate.",
  },
  message: {
    text: "Now click on the WORDS of a message that YOU sent in the same chat.",
    accept: (el, picks) => (picks.reply && (picks.reply === el || picks.reply.contains(el) || el.contains(picks.reply)) ? "That is part of the reply. Click one of your own messages." : null),
  },
  answer: { text: "Click just the part of the AI reply that is the answer itself (not its labels or buttons)." },
  card: {
    text: "Click the box that holds the text box together with its buttons (attach, mode, microphone, send).",
    hint: "The bar is placed inside this box. Click its empty border or background, not the text box itself.",
    accept: (el, picks) => (picks.composer && el.contains(picks.composer) && el !== picks.composer ? null : "That box must contain the text box. Click around it."),
  },
};


/** The label drawn on the page next to what was clicked at each step. */
export const MARK_LABELS = { composer: "1 · Text box", send: "2 · Send button", reply: "3 · AI reply", message: "4 · Your message", answer: "Answer part", card: "Box around the text box" };
