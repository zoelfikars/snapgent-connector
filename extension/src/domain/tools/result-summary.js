// SPDX-License-Identifier: GPL-3.0-or-later
// Classifies and summarises tool results/calls for the status chips. Pure.

export function argSummary(call) {
  if (!call) return "";
  const a = call.arguments || {};
  const k = Object.keys(a)[0];
  if (!k) return "";
  let v = String(a[k]);
  if (v.length > 34) v = v.slice(0, 31) + "…";
  return `${k}: ${v}`;
}

// An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
// Error executing code: …") instead of our ERROR wrapper - so a
// startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
// error as its summary (it will hit EVERY MCP server the same way). Treat a result whose FIRST
// line opens with an error lead-in as failed too. Deliberately PHRASE-based,
// not the bare words "error"/"failed", so a genuine success line like
// "Failed: 0" / "Error count: 0" is NOT misread as a failure.
const BODY_ERR_RE =
  /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;
export const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
export function bodyLooksFailed(feedback) {
  if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
  const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
  return BODY_ERR_RE.test(first);
}
// True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
export const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

// Some tools answer with raw JSON on one line, and a 44-char slice of it makes
// a chip that says nothing, e.g. `{"files":[{"path":"src/a`. Summarise the SHAPE instead,
// in the same spirit as the boot chip's "25 commands". Returns null when the
// body isn't JSON, so plain-text outputs keep their first line unchanged.
function jsonSummary(body) {
  if (!/^[[{]/.test(body) || body.length > 200000) return null;
  let v;
  try { v = JSON.parse(body); } catch { return null; }
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (!v || typeof v !== "object") return null;
  const keys = Object.keys(v);
  // The common MCP shape: one wrapper key holding the list. Its name is already
  // plural ("files", "matches"), so it reads correctly as-is - just drop the
  // trailing "s" when there is exactly one, so it says "1 file".
  if (keys.length === 1 && Array.isArray(v[keys[0]])) {
    const n = v[keys[0]].length;
    const word = n === 1 ? keys[0].replace(/s$/, "") : keys[0];
    return `${n} ${word}`;
  }
  // Otherwise show the scalar fields - that's what a human would read off.
  const scalars = keys
    .filter((k) => v[k] === null || typeof v[k] !== "object")
    .map((k) => `${k}: ${v[k]}`);
  if (scalars.length) return scalars.join(", ").slice(0, 44);
  return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
}

export function outSummary(feedback) {
  if (!feedback) return "";
  const isErr = feedbackIsError(feedback);
  const body = stripOutputPrefix(feedback).trim();
  if (!body) return "";
  // Errors are prose and read fine as-is; only reshape successful JSON.
  if (!isErr) { const j = jsonSummary(body); if (j) return j; }
  const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const lines = all.length;
  // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
  // before the real status so the chip shows the useful line, not the noise.
  let first = all[0] || "";
  if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
    first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
  }
  first = first.slice(0, 44);
  if (isErr) return first;
  return lines > 1 ? `${first} · ${lines} lines` : first;
}

/** Full arguments, shown in a tool chip's expandable body. */
export function callBody(call) {
  const args = call.arguments || {};
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}
