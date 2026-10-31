// SPDX-License-Identifier: GPL-3.0-or-later
// Rules for starting an agent session: what must be true first, and how to read the
// model's first replies. Pure.

import { bareToolName } from "../tools/names.js";
import { isListCommands } from "../tools/virtual-commands.js";

const WORKSPACE_REQUIRED = Object.freeze({ title: "VS Code workspace required", text: "Open a project folder in VS Code, then try again." });
export const workspaceRequiredBanner = () => ({ ...WORKSPACE_REQUIRED });

/** The cheap tool we call to prove a workspace is really open. */
export const WORKSPACE_PROBE_TOOL = "list_dir";

/**
 * Checks that need no I/O, in the order they are reported.
 * @returns {{ title: string, text: string } | null} a banner explaining what to fix, or null when ready
 */
export function checkStartPreconditions({ target, targetName, bridgeConnected, serverAlive, toolNames }) {
  const hasProbeTool = toolNames.some((name) => bareToolName(name) === WORKSPACE_PROBE_TOOL);
  if (target === "vscode" && bridgeConnected && serverAlive && !hasProbeTool) return workspaceRequiredBanner();
  if (!toolNames.length) return { title: `${targetName} tools unavailable`, text: "Is the server online?" };
  if (target === "vscode" && !hasProbeTool) return workspaceRequiredBanner();
  return null;
}

/** Did the workspace probe (list_dir ".") succeed? */
export const probeSucceeded = (result) => !!(result && result.ok);

/** Is this first reply exactly one list_commands/list_tools call (the handshake the prompt asks for)? */
export function isHandshake(response) {
  const calls = response && response.kind === "tool" ? response.calls : null;
  return !!(calls && calls.length === 1 && isListCommands(calls[0].tool));
}

/** An unavailable target answers list_commands with a plain note instead of the catalogue. */
export const handshakeUnavailable = (feedback) => /No commands available|has no commands available|is not available/i.test(feedback);
