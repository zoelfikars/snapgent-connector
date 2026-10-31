// SPDX-License-Identifier: GPL-3.0-or-later
// What chip a turn WE wrote deserves (the system prompt, its re-statements, tool results), judged from
// the turn's text alone. Turns the model wrote are harder (they depend on streaming state) and stay in
// the page-side sweep. Pure: text in, a chip description out.

import { RESEND_MARKER, SYS_MARKER } from "../domain/constants.js";
import { isInjectedFeedback } from "../domain/parser/detect.js";
import { IMAGE_FEEDBACK_RE } from "../domain/tools/result-feedback.js";
import { toolCategory } from "../domain/tools/category.js";

const TOOL_NAME_RE = /Output of '([^']+)'/;

/**
 * A system-prompt turn: the bootstrap, or a mid-session re-statement. The re-statement is checked first
 * because it carries the bootstrap marker too (that is what hides it); without that order it inherited
 * the bootstrap's "Starting Up" and read as if the agent had restarted.
 * @returns {null | { kind: "resend" | "bootstrap", phase: string, chip: object }}
 */
export function describeSystemTurn(text, { starting }) {
  if (text.includes(RESEND_MARKER)) {
    // The re-statement rides ON a tool result, so name that tool rather than leaving its result unlabelled.
    const tool = text.match(TOOL_NAME_RE);
    return {
      kind: "resend",
      phase: "remind",
      chip: { label: "Reminder", detail: tool ? `with ${tool[1]} result` : "", category: "remind", phase: "remind", cls: "sys", whole: true },
    };
  }
  if (text.includes(SYS_MARKER)) {
    const phase = starting ? "run" : "sys";
    return { kind: "bootstrap", phase, chip: { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true } };
  }
  return null;
}

/**
 * A user turn the EXTENSION injected: a tool result, an ERROR, or a note. Keyed off our fixed output
 * shapes, never off command keywords.
 * @returns {null | { toolName: string|null, isError: boolean, hasImage: boolean, signature: string, chip: object }}
 */
export function describeResultTurn(text) {
  if (!isInjectedFeedback(text)) return null;
  const tool = text.match(TOOL_NAME_RE);
  const toolName = tool ? tool[1] : null;
  const isError = /^\s*ERROR\b/.test(text);
  // A feedback that carries an image ends with a fixed phrase: the reload-proof signal.
  const hasImage = !isError && IMAGE_FEEDBACK_RE.test(text);
  return {
    toolName,
    isError,
    hasImage,
    signature: `${toolName || "note"}|${isError ? "err" : hasImage ? "img" : "result"}`,
    chip: {
      label: toolName ? `${toolName} · result` : "result",
      category: hasImage ? "screen" : toolName ? toolCategory(toolName) : "tool",
      body: text,
      phase: isError ? "err" : "result",
      cls: isError ? "err" : "result",
      whole: true,
    },
  };
}
