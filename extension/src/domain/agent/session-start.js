// SPDX-License-Identifier: GPL-3.0-or-later
// Rules for starting an agent session: what must be true first, and when the command list is not usable. Pure.

import { bareToolName } from "../tools/names.js";

const WORKSPACE_REQUIRED = Object.freeze({ title: "Workspace required", text: "Open a project folder in VS Code or Antigravity, then try again." });
export const workspaceRequiredBanner = () => ({ ...WORKSPACE_REQUIRED });

/** The cheap tool we call to prove a workspace is really open. */
export const WORKSPACE_PROBE_TOOL = "tree";

/** Tools that only a folder-aware server (VS Code and its forks) advertises: their presence is the tell. */
const WORKSPACE_TOOLS = ["tree", "list_dir", "list_commands"];

/** Whether this target works in a folder: VS Code, or any server that advertises a folder tool (an editor's fork, a remote). */
export function isWorkspaceServer(targetId, toolNames) {
  if (targetId === "vscode") return true;
  return (toolNames || []).some((name) => WORKSPACE_TOOLS.includes(bareToolName(name)));
}

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

/** An unavailable target answers list_commands with a plain note instead of the catalogue. */
export const handshakeUnavailable = (feedback) => /No commands available|has no commands available|is not available/i.test(feedback);
