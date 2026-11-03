// SPDX-License-Identifier: GPL-3.0-or-later
// Did a command fail, and what to call it while it runs. Pure.

import { withoutResultHeader } from "./result-marker.js";

/** The first argument of a call, shortened: "path: src/a.js". */
export function argSummary(call) {
  const args = (call && call.arguments) || {};
  const key = Object.keys(args)[0];
  if (!key) return "";
  const value = String(args[key]);
  return `${key}: ${value.length > 34 ? `${value.slice(0, 31)}…` : value}`;
}

/** What the composer cover says while a command runs: its place in a batch, its name, its first argument. */
export function runningLabel(call, step) {
  const arg = argSummary(call);
  return `${step && step.total > 1 ? `${step.index + 1}/${step.total} · ` : ""}${call.tool}${arg ? ` · ${arg}` : ""}`;
}

// A tool can report its own failure as a NORMAL result ("Error executing code: …"). Judged by the phrase that opens the
// result, not by the bare words "error" or "failed", so a success line like "Failed: 0" is not read as a failure.
const BODY_ERR_RE =
  /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;

/** Our own wrapper (`ERROR …`) or a tool's in-body error lead-in. */
export function feedbackIsError(feedback) {
  if (!feedback) return false;
  if (feedback.startsWith("ERROR")) return true;
  const first = withoutResultHeader(feedback).split("\n").map((line) => line.trim()).find(Boolean) || "";
  return BODY_ERR_RE.test(first);
}
