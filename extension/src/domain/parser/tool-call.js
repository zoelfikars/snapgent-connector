// SPDX-License-Identifier: GPL-3.0-or-later
// Turns the assistant's reply text into runnable { tool, arguments } calls.

import { START_M, END_M } from "./markers.js";
import { matchBrace, parseLoose, extractJson } from "./json-scan.js";
import { parseNative } from "./native/index.js";

// Normalise a parsed JSON object into { tool, arguments }, accepting both the
// new snapgentV3 schema ("command"/"params") and the function-calling
// schema ("tool"/"arguments"/"name"/"args"). Returns null if not a valid call.
export function normalizeCall(o) {
  if (!o || typeof o !== "object") return null;
  const name = o.command != null ? o.command : (o.tool != null ? o.tool : o.name);
  let args = o.params != null ? o.params : (o.arguments != null ? o.arguments : o.args);
  if (typeof name !== "string" || !name) return null;
  if (!args || typeof args !== "object") args = {};
  return { tool: name, arguments: args };
}

// Every {"command": ...} / {"tool": ...} object in the text, in the order written. Once an object is taken, scanning
// resumes AFTER it: a "command" key inside its params (run_command's own "command") is not another call.
function extractToolsAnywhere(text) {
  const keyRe = /"(?:command|tool)"\s*:/g;
  const out = [];
  let pos = 0;
  while (true) {
    keyRe.lastIndex = pos;
    const hit = keyRe.exec(text);
    if (!hit) break;
    const start = text.lastIndexOf("{", hit.index);
    if (start === -1 || start < pos) { pos = hit.index + 1; continue; }
    const end = matchBrace(text, start); // string-aware brace matching
    if (end === -1) { pos = hit.index + 1; continue; }
    let call = null;
    try { call = normalizeCall(parseLoose(text.slice(start, end + 1))); } catch { /* not JSON: keep looking */ }
    if (call) { out.push(call); pos = end + 1; } else pos = hit.index + 1;
  }
  return out;
}

export function parseToolCalls(r) {
  // Lowercase for case-insensitive end-marker search. Models write
  // ###end_mcp_tool### (underscore) or ###end-mcp_tool### (dash).
  const rLow = r.toLowerCase();
  const findEndM = (from) => {
    const a = rLow.indexOf("###end_mcp_tool###", from);
    const b = rLow.indexOf("###end-mcp_tool###", from);
    if (a === -1 && b === -1) return -1;
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  };
  const out = [];
  let from = 0;
  while (true) {
    const sm = r.indexOf(START_M, from);
    if (sm === -1) break;
    const em = findEndM(sm);
    if (em === -1) break;
    const body = r.slice(sm + START_M.length, em);
    for (const sub of body.split(START_M)) {
      const cleaned = sub.trim().replace(/^(?:json|JSON|Copy|copy)\s*/i, "").trim();
      if (!cleaned) continue;
      const p = normalizeCall(extractJson(cleaned));
      if (p) out.push(p);
    }
    from = em + END_M.length;
  }
  if (out.length === 0) {
    out.push(...extractToolsAnywhere(r));
  }
  // Last, the model's own markup (DeepSeek's DSML): only when it wrote no command of ours.
  if (out.length === 0) out.push(...parseNative(r));
  return out;
}
