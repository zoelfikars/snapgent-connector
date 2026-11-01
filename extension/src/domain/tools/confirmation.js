// SPDX-License-Identifier: GPL-3.0-or-later
// The user's approval for risky actions. The MCP server refuses such an action and hands the extension
// a one-time token; the extension asks the user and, if approved, repeats the call with that token in a
// reserved argument. The model must never be able to set it, so it is stripped from model arguments.

export const RESERVED_ARGUMENT = "__snapgent_confirm";
// The bar's choice (plan / manual / auto) travels in its own reserved argument; the model must not be able to pick its own mode.
export const MODE_ARGUMENT = "__snapgent_mode";

/** Model-supplied arguments, minus anything that could pose as an approval or a mode. */
export function withoutReserved(args) {
  const { [RESERVED_ARGUMENT]: _approval, [MODE_ARGUMENT]: _mode, ...rest } = args || {};
  return rest;
}

export const needsApproval = (result) =>
  !!(result && result.kind === "confirmation_required" && result.confirmation && result.confirmation.token);

export const declinedFeedback = (description) =>
  `ERROR: the user declined to approve this action: ${description}. It was NOT run. Do NOT retry it or look for a way around it; tell the user what you wanted to do and ask how to proceed.`;

export const unavailableFeedback = (description) =>
  `ERROR: this action needs the user's approval, but this page cannot ask for it: ${description}. It was NOT run.`;
