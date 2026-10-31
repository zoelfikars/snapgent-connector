// SPDX-License-Identifier: GPL-3.0-or-later
// Decides what the agent loop does with the response to one turn. Pure: it only
// maps (response, state) -> plan, so every branch is testable without a browser.

import { FEEDBACK } from "../prompt/feedback.js";
import { toolCategory } from "../tools/category.js";
import { toolNameFromText } from "../parser/detect.js";

export const MAX_TRUNCATED_RESUMES = 6;

// Why a command failed to parse, as the short label shown on its chip.
const PARSE_ERROR_DETAIL = {
  unclosed: "cut off",
  envelope: "bad format",
  dsml: "wrong format", // DeepSeek's own markup is not JSON: "bad JSON" would send people hunting for a typo
};
export const parseErrorDetail = (reason) => PARSE_ERROR_DETAIL[reason] || "bad JSON";

const end = (extra = {}) => ({ type: "end", ...extra });
const banner = (level, title, text) => ({ level, title, text });

/**
 * @typedef {{ type: "end", banner?: {level:string,title:string,text:string}, diag?: string }
 *   | { type: "resume-truncated" }
 *   | { type: "parse-error", chip: {item:object,name:string,detail:string}|null, feedback: string }
 *   | { type: "feedback", feedback: string }
 *   | { type: "run", call: {tool:string,arguments?:object}, category: string }
 *   | { type: "skip" }} Plan
 *
 * @param {object} res  A response from the chat watcher (`kind` plus kind-specific fields).
 * @param {{ displayName: string, truncCount: number, isHalted: () => boolean,
 *           maxResumes?: number, isLearnedImageTool?: (name: string) => boolean }} ctx
 * @returns {Plan & { truncCount: number }} the plan and the new consecutive-truncation count
 */
export function planTurn(res, { displayName, truncCount, isHalted, maxResumes = MAX_TRUNCATED_RESUMES, isLearnedImageTool = () => false }) {
  switch (res.kind) {
    case "context_limit":
      return { ...end({ banner: banner("limit", `${displayName} reached its context limit`, `${res.detail || ""} New chat.`) }), truncCount };
    case "too_long":
      return { ...end({ banner: banner("limit", "Conversation too long", "Too long. Start a new chat.") }), truncCount };
    case "timeout":
      return { ...end({ banner: banner("warn", `No response from ${displayName}`, "Timed out. Agent stopped.") }), truncCount };
    case "empty":
      // A dropped reply must be explained: ending silently leaves a grey "not run" chip with no clue why.
      return { ...end({ diag: "empty.end", banner: banner("warn", `${displayName} returned an empty reply`, "Nothing received. Try again.") }), truncCount };

    case "truncated":
      // A halted turn (user stop or self-halt) is never auto-resumed.
      if (isHalted()) return { ...end({ diag: "truncated.halted" }), truncCount };
      if (truncCount < maxResumes) return { type: "resume-truncated", truncCount: truncCount + 1 };
      if (res.text) return { ...end(), truncCount }; // give up resuming; keep what we have as the answer
      return { ...end({ banner: banner("warn", "Reply kept getting cut off", "Too long. Try shorter.") }), truncCount };

    case "parse_error": {
      const name = toolNameFromText(res.raw || "") || "command";
      const chip = res.item ? { item: res.item, name, detail: parseErrorDetail(res.reason), category: toolCategory(name) } : null;
      return { type: "parse-error", chip, feedback: FEEDBACK.parseError(res.reason), truncCount: 0 };
    }

    case "text":
      return { ...end(), truncCount: 0 }; // final answer

    case "tool": {
      if (res.calls.length > 1) {
        return { type: "feedback", feedback: FEEDBACK.multiTool(res.calls.map((c) => c.tool || "?")), truncCount: 0 };
      }
      const call = res.calls[0];
      // A tool already seen to return an image gets the "screen" chip optimistically.
      const category = isLearnedImageTool(call.tool) ? "screen" : toolCategory(call.tool);
      return { type: "run", call, category, truncCount: 0 };
    }

    default:
      return { type: "skip", truncCount: 0 };
  }
}
