// SPDX-License-Identifier: GPL-3.0-or-later
// Cheap, side-effect-free predicates the response watcher asks about a reply.

import { START_M, CMD_KEY_RE } from "./markers.js";
import { matchBrace } from "./json-scan.js";
import { startsWithResult } from "../tools/result-marker.js";

export function hasToolSignature(r) {
  return (
    r.includes(START_M) ||
    r.includes("MCP_TOOL") ||
    CMD_KEY_RE.test(r)
  );
}

// True if the reply contains a tool block that has STARTED but not yet CLOSED
// (a ###MCP_TOOL### opener with no matching end marker). Used by the
// response watcher to avoid finalizing a command that is still being streamed.
export function hasOpenToolBlock(r) {
  if (!r) return false;
  const sm = r.indexOf(START_M);
  if (sm !== -1) {
    const low = r.toLowerCase();
    if (low.indexOf("###end_mcp_tool###", sm) === -1 && low.indexOf("###end-mcp_tool###", sm) === -1) return true;
  }
  // An inline JSON command ({"command"/"tool": …}) whose object has NOT closed yet
  // is still being streamed (a big multi_edit can take many seconds). Treat it as
  // open so the watcher keeps waiting instead of finalizing - and failing to parse -
  // half a command, which would drop the tool and end the turn as plain text.
  for (const key of ['"command"', '"tool"']) {
    const k = r.indexOf(key);
    if (k === -1) continue;
    const open = r.lastIndexOf("{", k);
    if (open !== -1 && matchBrace(r, open) === -1) return true;
  }
  return false;
}

export function toolNameFromText(txt) {
  // The name even BEFORE its closing quote, so a command still being typed is named as it is typed. A value that is still empty
  // or only whitespace (a site can render `"tool": "    "` for a beat) falls through to the placeholder below.
  const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
  if (m && m[1].trim()) return m[1].trim();
  return "command";
}

// A turn the EXTENSION injected (always sent as a user turn): a tool result, an
// ERROR, or a "(System note: …)" control message. Matched ONLY by the fixed
// shapes we emit - never by command-like keywords, since a parse-error note
// quotes a {"command": …} example that must NOT be read as a real command.
export function isInjectedFeedback(txt) {
  return startsWithResult(txt) ||
         /^\s*ERROR\b/.test(txt) ||
         /^\s*\(System note:/.test(txt);
}
