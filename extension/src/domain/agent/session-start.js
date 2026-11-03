// SPDX-License-Identifier: GPL-3.0-or-later
// Rules for starting an agent session: what must be true first, and how to read the
// model's first replies. Pure.

import { bareToolName } from "../tools/names.js";
import { isListCommands } from "../tools/virtual-commands.js";

const WORKSPACE_REQUIRED = Object.freeze({ title: "VS Code workspace required", text: "Open a project folder in VS Code, then try again." });
export const workspaceRequiredBanner = () => ({ ...WORKSPACE_REQUIRED });

/** The cheap tool we call to prove a workspace is really open. */
export const WORKSPACE_PROBE_TOOL = "tree";

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

/**
 * Is this first reply the list_commands/list_tools call the prompt asks for? Commands written after it in the same
 * reply do not count against it (a model that groups commands will often add one): only the handshake itself is run.
 */
export function isHandshake(response) {
  const calls = response && response.kind === "tool" ? response.calls : null;
  return !!(calls && calls.length >= 1 && isListCommands(calls[0].tool));
}

/** Said to the model when its handshake reply carried more than list_commands: nothing else ran. */
export const HANDSHAKE_EXTRA_NOTE =
  "\n\n(Only list_commands was run. Any other command in that reply was NOT run: write it again, after the user's task, if it is still needed.)";

/** An unavailable target answers list_commands with a plain note instead of the catalogue. */
export const handshakeUnavailable = (feedback) => /No commands available|has no commands available|is not available/i.test(feedback);
