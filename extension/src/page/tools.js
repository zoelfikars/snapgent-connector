// SPDX-License-Identifier: GPL-3.0-or-later
// Running commands on the MCP server: the catalogue of what the server offers, the runner that executes one command under the
// user's approval mode, the skills the model may read, and the system prompt that tells the model how all of it works.

import { SkillsService, ToolCatalogue, ToolRunner } from "../application/index.js";
import { bareToolName } from "../domain/tools/names.js";
import { buildSystemPrompt } from "../domain/prompt/system-prompt.js";
import { toolsReminder } from "../domain/prompt/reminder.js";
import { createConfirmDialog } from "../ui/index.js";

/**
 * @param {{ send: Function, provider: object, state: object, settings: object, serverDirectory: object, visibility: object,
 *           storage: object, diag: Function, banner: Function }} deps  `banner(level, title, text)` shows the user a notice
 */
export function createTools({ send, provider, state, settings, serverDirectory, visibility, storage, diag, banner }) {
  const bridge = {
    listTools: () => send({ type: "list_tools" }),
    callTool: (request) => send({ type: "call_tool", ...request }),
  };
  const session = {
    target: settings.target,
    isEnabled: (id) => serverDirectory.isEnabled(id),
    servers: () => state.bridge.servers || [],
    supportsVision: () => !!provider.supportsVision,
    isStopped: () => state.stop,
  };
  // Images are not carried back to the model (supportsVision is false everywhere), so a tool that returns one only gets an error text.
  const sink = { images() {}, staleExtension: () => banner("warn", "Reload page", "Updated. Press F5."), diag };
  const catalogue = new ToolCatalogue({ bridge, session, diag });
  // Risky actions need the user's approval: a top-layer dialog in a closed shadow root that ignores synthetic clicks.
  const confirm = createConfirmDialog();
  const runner = new ToolRunner({ bridge, catalogue, session, visibility, sink, confirm, approvalMode: settings.approvalMode });
  const skills = new SkillsService({
    store: storage,
    findTool: (bareName) => catalogue.active().find((tool) => bareToolName(tool.name) === bareName),
    callTool: (name, args, timeout) => send({ type: "call_tool", name, arguments: args, timeout }),
    diag,
    log: (...args) => console.log("[snapgentV3]", ...args),
  });

  /** The system prompt for this site and these settings: one definition for the start and for any re-statement. */
  const systemPrompt = () => buildSystemPrompt({
    siteName: provider.displayName,
    customPrompt: serverDirectory.customPrompt,
    targetServer: settings.target(),
    targetName: serverDirectory.name(settings.target()),
    skills: skills.enabled,
  });

  /** The command list the model is reminded of every so often, scoped to the selected target. */
  const reminderText = () => toolsReminder(catalogue.active(), serverDirectory.name(settings.target()), settings.target());

  return { bridge, session, catalogue, confirm, runner, skills, systemPrompt, reminderText };
}
