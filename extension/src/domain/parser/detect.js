// SPDX-License-Identifier: GPL-3.0-or-later
// Cheap, side-effect-free predicates the response watcher asks about a reply.

import { START_M, CMD_KEY_RE, DSML_RE } from "./markers.js";
import { matchBrace } from "./json-scan.js";

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
  // Match the name even BEFORE its closing quote (`[^"]*`), so the chip shows
  // the real command name AS IT IS TYPED instead of a generic "command"
  // placeholder until the JSON closes. A still-empty value falls through.
  // Trim: while the value is still streaming it can be whitespace-only (e.g.
  // Kimi renders `"tool": "    "` for a beat), which would otherwise show a
  // blank chip label until the loop repaints it. A whitespace value falls
  // through to the placeholder below instead.
  const m = txt.match(/"(?:command|tool)"\s*:\s*"([^"]*)/);
  if (m && m[1].trim()) return m[1].trim();
  return "command";
}

// A turn the EXTENSION injected (always sent as a user turn): a tool result, an
// ERROR, or a "(System note: …)" control message. Matched ONLY by the fixed
// shapes we emit - never by command-like keywords, since a parse-error note
// quotes a {"command": …} example that must NOT be read as a real command.
export function isInjectedFeedback(txt) {
  return /^\s*Output of '/.test(txt) ||
         /^\s*ERROR\b/.test(txt) ||
         /^\s*\(System note:/.test(txt);
}

// The assistant emitted a snapgentV3 command (JSON or an ###MCP_TOOL### block), or a
// command-turn ATTEMPT the camouflage sweep should still mask. DSML counts:
// the turn IS the model calling a tool, just in the wrong dialect, so it gets a
// chip like any other command turn instead of dumping raw markup at the user
// (reported live 2026-08-22 - the error fired correctly but the tags stayed on
// screen). Note this is deliberately NOT mirrored in hasToolSignature: that
// one gates the parse/execute path, and DSML must keep falling through to the
// classify ladder so it fires the "dsml" parse_error rather than being handed
// to parseToolCalls, which cannot read it.
export function hasCommandShape(txt) {
  return txt.includes(START_M) ||
         DSML_RE.test(txt) ||
         CMD_KEY_RE.test(txt); // command/tool with OR without params (e.g. list_commands)
}
