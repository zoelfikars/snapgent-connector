// SPDX-License-Identifier: GPL-3.0-or-later
// What does not fit in ONE message to the chat goes in the next ones. The model is told, in the part it has, that more follows and
// that it should only acknowledge briefly (so it does not act on half of the output); the last part says it is everything.
// This module cuts the text and writes those notes. Pure.

/** Room each part keeps for its own notes. */
export const PART_NOTE_CHARS = 500;

/** Cut at the end of a line when one is near the end of the piece, so a line is not split when it need not be. */
function cut(text, size) {
  if (text.length <= size) return text.length;
  const newline = text.lastIndexOf("\n", size);
  return newline > size * 0.8 ? newline + 1 : size;
}

/** `text` in pieces of at most `size` characters, at most `max` of them (what is left after that is cut out and said so). */
export function splitIntoParts(text, size, max = Infinity) {
  const pieces = [];
  let rest = text;
  while (rest.length && pieces.length < max) {
    const at = cut(rest, size);
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length) pieces[pieces.length - 1] += `\n... [${rest.length.toLocaleString("en-US")} more characters left out: too much for ${max} messages] ...`;
  return pieces;
}

const WAIT = "Reply with a few words only (for example \"received\") and wait for the rest. Do not act on this yet.";

/** The messages to send, in order: `text` split to fit `size` per message, each with its notes. One message when it all fits. */
export function partMessages(text, size, max = Infinity) {
  if (text.length <= size) return [text];
  const pieces = splitIntoParts(text, Math.max(1, size - PART_NOTE_CHARS), max);
  if (pieces.length < 2) return pieces;
  const total = pieces.length;
  return pieces.map((piece, index) => {
    const last = index === total - 1;
    const head = index === 0 ? "" : `\u00bb continued\n[Part ${index + 1} of ${total}${last ? ", the last" : ""}]\n`;
    const note = last
      ? `\n\n[Part ${total} of ${total}, the last: that is everything. Carry on with the task now.]`
      : `\n\n[Part ${index + 1} of ${total}: there was too much for one message, the rest follows in the next one. ${WAIT}]`;
    return head + piece + note;
  });
}
