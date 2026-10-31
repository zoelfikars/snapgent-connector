// SPDX-License-Identifier: GPL-3.0-or-later
// Last-resort recovery of a command whose trailing closers were cut off.

import { matchBrace, parseLoose } from "./json-scan.js";
import { normalizeCall } from "./tool-call.js";

// Last-resort salvage of a CUT-OFF JSON command: the model hit its output
// limit with the whole payload complete but the trailing closers missing
// (seen live on Qwen: a big multi_edit missing exactly ONE final "}").
// Strictly conservative - we only auto-close when it is provably just the
// closing sequence that was lost, never when actual content was amputated:
//  - the scan must NOT end inside a string literal (a value cut mid-string
//    means real content is missing → keep the parse_error);
//  - the last non-whitespace char must terminate a complete JSON value
//    (`"`, `}`, `]`, digit, or the tail of true/false/null);
//  - at most MAX_SALVAGE_CLOSERS closers may be appended. 2 covers the
//    root-brace and params-brace cases; a deeper deficit usually means the
//    cut fell between items (e.g. mid-edits-array), where running a partial
//    command would be dangerous - the retry feedback stays the right call.
// Callers must only invoke this once generation has ENDED (the watcher's
// parse_error branch), never on a still-streaming reply.
const MAX_SALVAGE_CLOSERS = 2;
export function salvageCutOff(text) {
  for (const key of ['"command"', '"tool"']) {
    const k = text.indexOf(key);
    if (k === -1) continue;
    const start = text.lastIndexOf("{", k);
    if (start === -1) continue;
    if (matchBrace(text, start) !== -1) continue; // closed → not our case
    // String-aware bracket stack from the opener to the end of the text.
    const stack = [];
    let inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") stack.push("}");
      else if (c === "[") stack.push("]");
      else if (c === "}" || c === "]") {
        if (stack.pop() !== c) return null; // mismatched nesting → hopeless
      }
    }
    if (inStr) return null;                       // cut mid-string value
    if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
    const body = text.slice(start).trimEnd();
    if (!/["}\]0-9]$|(?:true|false|null)$/.test(body)) return null; // value incomplete
    try {
      const call = normalizeCall(parseLoose(body + stack.reverse().join("")));
      if (call) return call;
    } catch {}
    return null;
  }
  return null;
}
