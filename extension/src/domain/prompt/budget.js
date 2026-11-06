// SPDX-License-Identifier: GPL-3.0-or-later
// How big ONE message sent into the chat may be. The limit that matters to a chat site is the whole
// message, not any single file read: results, the command list reminder and a re-stated system prompt
// all ride together. This module only does the arithmetic; the loop applies it. Pure.

export const DEFAULT_PROMPT_CHARS = 100000;
export const MIN_PROMPT_CHARS = 20000;
export const MAX_PROMPT_CHARS = 1100000;
/** A command is only worth running when at least this much room is left for its output. */
export const MIN_CALL_CHARS = 2000;
/** The name line and separators around each result. */
export const CALL_OVERHEAD_CHARS = 200;
/** One reply may carry this many commands (the popup's slider sets it); more are reported as not run. */
export const DEFAULT_BATCH_CALLS = 8;
export const MIN_BATCH_CALLS = 1;
export const MAX_BATCH_CALLS = 30;
/** What does not fit in one message goes in the next ones, up to this many messages in all; the rest is cut out. */
export const MAX_RESULT_PARTS = 5;
/** A conversation this many messages' worth big is worth a warning (history counts against the context too). */
export const SESSION_WARN_FACTOR = 6;

/** The user's setting, kept within what the slider allows. Anything unusable falls back to the default. */
export function clampPromptChars(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_PROMPT_CHARS;
  return Math.min(MAX_PROMPT_CHARS, Math.max(MIN_PROMPT_CHARS, number));
}

/** The commands-per-reply setting, kept within what the slider allows. */
export function clampBatchCalls(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_BATCH_CALLS;
  return Math.min(MAX_BATCH_CALLS, Math.max(MIN_BATCH_CALLS, number));
}

/** The setting, lowered by what this site (or an earlier "too long" from it) is known to accept. */
export function effectiveLimit(setting, siteCap) {
  const limit = clampPromptChars(setting);
  return Number.isFinite(siteCap) && siteCap > 0 ? Math.max(MIN_PROMPT_CHARS, Math.min(limit, Math.floor(siteCap))) : limit;
}

/** What each of the calls still to run may use: an even split of what is left (unused room flows on). */
export function callShare(remaining, callsLeft) {
  return Math.max(MIN_CALL_CHARS, Math.floor(remaining / Math.max(1, callsLeft)) - CALL_OVERHEAD_CHARS);
}

/** Keep the start and the end of `text` within `limit` characters, saying how much was left out. */
export function trimMiddle(text, limit, what = "this message") {
  if (text.length <= limit) return text;
  const marker = (omitted) => `\n... [${omitted.toLocaleString("en-US")} characters omitted to keep ${what} within the size limit] ...\n`;
  const room = Math.max(0, limit - marker(text.length).length);
  const head = Math.floor(room * 0.4);
  const tail = room - head;
  return text.slice(0, head) + marker(text.length - head - tail) + (tail ? text.slice(text.length - tail) : "");
}

/**
 * One message out of several results. Each result already names its command (see result-marker.js), so they are
 * simply stacked; commands that did not run are listed so the model can send them again.
 * @param {string[]} results
 * @param {{ tool: string, why: string }[]} notRun
 */
export function composeBatch(results, notRun = []) {
  let text = results.join("\n\n");
  if (notRun.length) {
    const reasons = [...new Set(notRun.map((item) => item.why))].join("; ");
    text += `${text ? "\n\n" : ""}NOT RUN (${reasons}): ${notRun.map((item) => item.tool || "?").join(", ")}. Send them again, one reply at a time, if they are still needed.`;
  }
  return text;
}

/** Has this conversation sent so much that a fresh one is worth suggesting? */
export const sessionIsLarge = (sentChars, limit) => sentChars >= limit * SESSION_WARN_FACTOR;
