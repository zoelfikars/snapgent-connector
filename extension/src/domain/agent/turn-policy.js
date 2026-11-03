// SPDX-License-Identifier: GPL-3.0-or-later
// Decides what the agent loop does with the response to one turn. Pure: it only
// maps (response, state) -> plan, so every branch is testable without a browser.

import { FEEDBACK } from "../prompt/feedback.js";

export const MAX_TRUNCATED_RESUMES = 6;

/** The engine cannot find the reply the site is generating: the page layout is not understood. */
export const unreadableBanner = (displayName) => ({
  level: "warn",
  title: `Can't read ${displayName}'s replies`,
  text: "The site layout may have changed. Details are in the console ([zs-diag] layout.unreadable).",
});

const end = (extra = {}) => ({ type: "end", ...extra });
const banner = (level, title, text) => ({ level, title, text });

/**
 * @typedef {{ type: "end", banner?: {level:string,title:string,text:string}, diag?: string }
 *   | { type: "resume-truncated" }
 *   | { type: "parse-error", feedback: string }
 *   | { type: "run", calls: {tool:string,arguments?:object}[] }
 *   | { type: "skip" }} Plan
 *
 * @param {object} res  A response from the chat watcher (`kind` plus kind-specific fields).
 * @param {{ displayName: string, truncCount: number, isHalted: () => boolean, maxResumes?: number }} ctx
 * @returns {Plan & { truncCount: number }} the plan and the new consecutive-truncation count
 */
export function planTurn(res, { displayName, truncCount, isHalted, maxResumes = MAX_TRUNCATED_RESUMES }) {
  switch (res.kind) {
    case "context_limit":
      return { ...end({ banner: banner("limit", `${displayName} reached its context limit`, `${res.detail || ""} New chat.`) }), truncCount };
    case "too_long":
      return { ...end({ banner: banner("limit", "Conversation too long", "Too long. Start a new chat.") }), truncCount };
    case "timeout":
      return { ...end({ banner: banner("warn", `No response from ${displayName}`, "Timed out. Agent stopped.") }), truncCount };
    case "unreadable":
      // Generating, but no reply turn can be found: the page layout is not understood.
      return { ...end({ banner: unreadableBanner(displayName) }), truncCount };
    case "empty":
      // A dropped reply must be explained: ending silently leaves the user with no clue why.
      return { ...end({ diag: "empty.end", banner: banner("warn", `${displayName} returned an empty reply`, "Nothing received. Try again.") }), truncCount };

    case "truncated":
      // A halted turn (user stop or self-halt) is never auto-resumed.
      if (isHalted()) return { ...end({ diag: "truncated.halted" }), truncCount };
      if (truncCount < maxResumes) return { type: "resume-truncated", truncCount: truncCount + 1 };
      if (res.text) return { ...end(), truncCount }; // give up resuming; keep what we have as the answer
      return { ...end({ banner: banner("warn", "Reply kept getting cut off", "Too long. Try shorter.") }), truncCount };

    case "parse_error":
      return { type: "parse-error", feedback: FEEDBACK.parseError(res.reason), truncCount: 0 };

    case "text":
      return { ...end(), truncCount: 0 }; // final answer

    case "tool":
      // Several commands in one reply are all run, in order, and answered with ONE message (see BatchRunner).
      return { type: "run", calls: res.calls, truncCount: 0 };

    default:
      return { type: "skip", truncCount: 0 };
  }
}
