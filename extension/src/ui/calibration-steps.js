// SPDX-License-Identifier: GPL-3.0-or-later
// What the calibration dialog asks for, in order, and what counts as an acceptable click at each step.

export const EDITABLE = 'textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const CLICKABLE = "button, [role=button], a, input[type=submit]";
export const FLOWS = { all: ["composer", "send", "reply", "message"], composer: ["composer"], send: ["send"], reply: ["reply", "message"] };
export const PREVIEW_CHARS = 700;

export const STEPS = {
  composer: {
    text: "Click inside the text box where you type your message to the AI.",
    refine: (el) => el.closest(EDITABLE) || el,
    accept: (el) => (el.matches(EDITABLE) ? null : "That does not look like a text box. Click inside the box where you type."),
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
};


/** The label drawn on the page next to what was clicked at each step. */
export const MARK_LABELS = { composer: "1 · Text box", send: "2 · Send button", reply: "3 · AI reply", message: "4 · Your message", answer: "Answer part" };
