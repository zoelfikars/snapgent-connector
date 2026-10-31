// SPDX-License-Identifier: GPL-3.0-or-later
// What a finished tool call looks like to the user (chip) and to diagnostics.

import { feedbackIsError, outSummary, stripOutputPrefix } from "./result-summary.js";

/** @param {string} feedback the text returned by the tool runner */
export function describeOutcome(feedback) {
  const isErr = feedbackIsError(feedback);
  const body = stripOutputPrefix(feedback);
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    isErr,
    phase: isErr ? "err" : "done",
    summary: outSummary(feedback),
    body,
    lineCount: lines.length,
    firstLine: (lines[0] || "").slice(0, 90),
    lastLine: (lines[lines.length - 1] || "").slice(0, 90),
  };
}
