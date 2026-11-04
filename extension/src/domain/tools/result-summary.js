// SPDX-License-Identifier: GPL-3.0-or-later
// Did a command fail, and what to call it while it runs. Pure.

import { withoutResultHeader } from "./result-marker.js";

const FULL_CHARS = 400;

const clip = (text) => (text.length > FULL_CHARS ? `${text.slice(0, FULL_CHARS - 1)}…` : text);
const shellWord = (word) => (/\s/.test(word) ? JSON.stringify(word) : word);

/** The first argument of a call, shortened: "path: src/a.js". */
export function argSummary(call) {
  const args = (call && call.arguments) || {};
  const key = Object.keys(args)[0];
  if (!key) return "";
  const value = String(args[key]);
  return `${key}: ${value.length > 34 ? `${value.slice(0, 31)}…` : value}`;
}

/** What is being run, in full: a command with all its arguments (`go test ./... -run TestX`), otherwise the first argument. */
export function runningDetail(call) {
  const args = (call && call.arguments) || {};
  if (typeof args.command === "string") {
    const rest = Array.isArray(args.args) ? args.args.map((word) => shellWord(String(word))) : [];
    return clip([args.command, ...rest].join(" "));
  }
  const key = Object.keys(args)[0];
  if (!key) return "";
  return clip(`${key}: ${Array.isArray(args[key]) ? args[key].join(", ") : String(args[key])}`);
}

/** What the composer cover says while a command runs: its place in a batch, its name, and what it is running. */
export function runningLabel(call, step) {
  const detail = runningDetail(call);
  return `${step && step.total > 1 ? `${step.index + 1}/${step.total} · ` : ""}${call.tool}${detail ? ` · ${detail}` : ""}`;
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
