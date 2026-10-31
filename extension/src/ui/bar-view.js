// SPDX-License-Identifier: GPL-3.0-or-later
// What the status bar says. Pure: the page's state goes in, a description of the bar comes out;
// drawing it is somebody else's job. The order of the checks below IS the priority of the messages.

import { escapeHtml } from "./html.js";

/**
 * @typedef {Object} BarState
 * @property {boolean} staleExtension   The page outlived its extension build: nothing else can be true.
 * @property {boolean} starting         The bootstrap is running.
 * @property {boolean} started          A session is live in this chat.
 * @property {boolean} running          The agent loop is running.
 * @property {boolean} parked           The loop is paused because the tab is in the background.
 * @property {boolean} blankChat        The chat is empty (so "Start" makes sense).
 * @property {{ connected: boolean, needsApproval?: boolean, servers?: Array<{id: string, alive?: boolean, tools?: number}> }} bridge
 * @property {boolean} bridgeOk         The selected target is connected and has tools.
 * @property {{ id: string, name: string }} target
 * @property {number} activeToolCount   Tools the model currently has.
 * @property {boolean} workspaceReady   VS Code has a folder open (only meaningful for the vscode target).
 * @property {boolean} workspaceProbePending
 * @property {string|null} modeWarning  The site is in a chat mode we cannot work in.
 *
 * @typedef {Object} BarView
 * @property {"standby"|"active"|"warn"|"noagent"|"starting"} tone
 * @property {boolean} spinner
 * @property {string} message           HTML.
 * @property {string} label             Text of the primary button.
 * @property {""|"start"|"starting"} kind  "" = no primary action.
 * @property {boolean} disabled
 * @property {boolean} warn
 */

const view = (tone, message, extra = {}) => ({ tone, message, spinner: false, label: "", kind: "", disabled: false, warn: false, ...extra });

const START = "▶︎ Start";

function whileStarted(state) {
  const server = (state.bridge.servers || []).find((item) => item.id === state.target.id);
  const tools = state.activeToolCount || (server && server.tools) || 0;
  const name = escapeHtml(state.target.name);
  if (!state.bridge.connected) return view("warn", `<b>Active</b> · ${state.bridge.needsApproval ? "approve in the bridge window" : "start the bridge"}`, { warn: true });
  if (!state.bridgeOk) return view("warn", `<b>Active</b> · ${name} offline`, { warn: true });
  return view("active", `<b>Active</b>${tools ? ` · ${tools} tools` : ""} · ${name}`);
}

function beforeStart(state) {
  const isVscode = state.target.id === "vscode";
  if (state.bridgeOk && (!isVscode || state.workspaceReady)) return view("standby", "Ready.", { label: START, kind: "start" });
  const server = (state.bridge.servers || []).find((item) => item.id === state.target.id);
  const folderMissing = isVscode && state.bridge.connected && !!server && !!server.alive && !(server.tools > 0);
  let message;
  if (!state.bridge.connected) message = state.bridge.needsApproval ? "Approve this extension in the <b>bridge window</b>" : "Start the <b>bridge</b>";
  else if (isVscode && (state.bridgeOk || folderMissing)) {
    message = state.workspaceProbePending ? "Checking <b>VS Code workspace</b>…" : "Open a <b>folder in VS Code</b>";
  } else message = `<b>${escapeHtml(state.target.name)} unavailable</b>`;
  return view("warn", message, { label: START, kind: "start", disabled: true, warn: true });
}

/** @param {BarState} state @returns {BarView} */
export function computeBarView(state) {
  // An orphaned page can show nothing but "reload": everything else would be a frozen snapshot.
  if (state.staleExtension) return view("warn", "<b>Disconnected</b> · reload page", { warn: true });

  let result;
  if (state.starting) result = view("starting", "Starting…", { spinner: true, label: "Starting…", kind: "starting", disabled: true });
  else if (state.started) result = whileStarted(state);
  else if (state.blankChat) result = beforeStart(state);
  else result = view("noagent", "No agent. Open a new chat.");

  // The loop is alive but frozen because this tab is in the background: say so, or it reads as a hang.
  if (state.parked && (state.running || state.starting)) {
    result = { ...result, tone: "warn", warn: false, message: "<b>Paused</b> · open this tab" };
  }
  // Some sites only work in one chat mode; until the user switches back, Start is disabled.
  if (!state.started && !state.starting && state.modeWarning) {
    result = { ...result, tone: "warn", warn: true, message: state.modeWarning, disabled: result.kind === "start" ? true : result.disabled };
  }
  return result;
}
