// SPDX-License-Identifier: GPL-3.0-or-later
// What the calibration dialog asks for, in order, and what counts as an acceptable click at each step.

export const EDITABLE = 'textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const CLICKABLE = "button, [role=button], a, input[type=submit]";
export const FLOWS = { all: ["composer", "send", "reply", "message"], composer: ["composer"], send: ["send"], reply: ["reply", "message"] };
export const PREVIEW_CHARS = 700;

export const STEPS = {
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

