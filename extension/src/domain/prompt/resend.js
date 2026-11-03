// SPDX-License-Identifier: GPL-3.0-or-later
// Rules for re-stating the system prompt mid-conversation. Some sites summarise
// their own context; the model then keeps the gist of the task but forgets that an
// extension runs its commands. A periodic re-statement fixes that. Pure rules only.

import { LEGACY_SESSION_MARKER, SESSION_PHRASE } from "../constants.js";
import { isInjectedFeedback } from "../parser/detect.js";

/** Injected tool results measure context VOLUME, which is what makes a site summarise. */
export const RESEND_RESULTS_EVERY = 12;

/** A re-statement is owed once EITHER budget is spent (typed turns or injected results). */
export function isResendDue({ users, results }, { everyUsers, everyResults = RESEND_RESULTS_EVERY }) {
  if (!everyUsers) return false;
  return users >= everyUsers || results >= everyResults;
}

/** Does the rider fit in the site's send budget alongside the result it rides on? */
export const fitsBudget = (resultLength, riderLength, cap = Infinity) => resultLength + riderLength <= cap;

/** The passenger appended to a tool result: the instructions again, framed as a reminder and not a request. */
export function buildResendRider(prompt) {
  return (
    "\n\n---\n" +
    "(A reminder from me, not a new request: there is nothing to answer here. In a long conversation this can get lost, so here is how we are working " +
    "together once more. The commands do run on my machine, and what they return is what you have been getting from me. Just carry on with the task; " +
    "do not acknowledge this note.)\n\n" +
    prompt
  );
}

/**
 * Lower bound read from what is on screen: walk back from the newest turn to the last turn that
 * carried the marker (the bootstrap or a rider), counting typed turns and injected results.
 * Items are read lazily, newest first, so a long history is never fully classified.
 * @param {number} length number of turns on screen
 * @param {(index: number) => { text: string, isUser: boolean }} itemAt oldest-first accessor
 */
export function countSinceLastMarker(length, itemAt) {
  let users = 0;
  let results = 0;
  for (let i = length - 1; i >= 0; i--) {
    const { text, isUser } = itemAt(i);
    if (text.includes(SESSION_PHRASE) || text.includes(LEGACY_SESSION_MARKER)) break;
    if (!isUser) continue;
    if (isInjectedFeedback(text)) results++;
    else users++;
  }
  return { users, results };
}
