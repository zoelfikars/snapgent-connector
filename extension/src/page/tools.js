// SPDX-License-Identifier: GPL-3.0-or-later
// Running commands on the MCP server: the catalogue of what the server offers, the runner that executes one command under the
// user's approval mode, the skills the model may read, and the system prompt that tells the model how all of it works.

import { SkillsService, ToolCatalogue, ToolRunner, chooseWorkspace } from "../application/index.js";
import { bareToolName } from "../domain/tools/names.js";
import { buildSystemPrompt } from "../domain/prompt/system-prompt.js";
import { toolsReminder } from "../domain/prompt/reminder.js";
import { withoutResultHeader } from "../domain/tools/result-marker.js";
import { ROOT_ARGUMENT } from "../domain/tools/confirmation.js";
import { createChoiceDialog, createConfirmDialog } from "../ui/index.js";
import { createWorkspaceBinding } from "./workspace-binding.js";

/**
 * @param {{ send: Function, provider: object, state: object, settings: object, serverDirectory: object, visibility: object,
 *           storage: object, diag: Function, banner: Function, terminal?: object, accountKey?: () => string }} deps  `banner(level, title, text)`
 *   shows the user a notice; `terminal` receives the live output of commands (see page/terminal.js)
 */
export function createTools({ send, provider, state, settings, serverDirectory, visibility, storage, diag, banner, terminal = null, accountKey = () => "" }) {
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
  // `terminal` is the page's terminal panel: a run_command tab opens the moment its call is made, and
  // live output arrives through the background's `tool_stream` pushes (see page/terminal.js).
  const sink = {
    images() {},
    staleExtension: () => banner("warn", "Reload page", "Updated. Press F5."),
    diag,
    terminal: terminal ? { begin: terminal.begin, finish: terminal.finish } : null,
  };
  const catalogue = new ToolCatalogue({ bridge, session, diag });
  // Risky actions need the user's approval: a top-layer dialog in a closed shadow root that ignores synthetic clicks.
  const confirm = createConfirmDialog();
  const bindings = createWorkspaceBinding({ storage, provider, accountKey });
  const choice = createChoiceDialog();
  const runner = new ToolRunner({ bridge, catalogue, session, visibility, sink, confirm, approvalMode: settings.approvalMode, workspaceRoot: bindings.current });
  // Commands the user types into the terminal run apart from the agent loop: a Stop that ended the loop leaves
  // `state.stop` set, and that must not cancel what the user runs by hand afterwards.
  const manual = new ToolRunner({ bridge, catalogue, session: { ...session, isStopped: () => false }, visibility, sink, confirm, approvalMode: settings.approvalMode, workspaceRoot: bindings.current });
  const skills = new SkillsService({
    store: storage,
    findTool: (bareName) => catalogue.active().find((tool) => bareToolName(tool.name) === bareName),
    callTool: (name, args, timeout) => send({ type: "call_tool", name, arguments: args, timeout }),
    diag,
    log: (...args) => console.log("[snapgentV3]", ...args),
  });

  // Which folder the user chose, as the server sees it (the prompt opens with its name).
  let workspaceInfo = null;
  let settledAt = 0;
  let settling = false;
  const workspace = {
    /** The folder this chat works in. */
    bound: bindings.current,
    /** `args` for a VS Code call made outside the runner, with the chat's folder. */
    withRoot(args) {
      const root = bindings.current();
      return root ? { ...args, [ROOT_ARGUMENT]: root } : args;
    },
    /** The user chose a folder for this chat (null: let it follow the server again). */
    bind(path) { bindings.bind(path); },
    clearPending: bindings.clearPending,
    commit: bindings.commit,
    /**
     * Before a session starts: which folder will this chat work in? The pinned folder when there is one, the only open folder, or the
     * user's pick when VS Code has several open. `{ path }`, or `{ none }` (nothing open), `{ cancelled }`, `{ error }`.
     */
    async choose() {
      const picked = await chooseWorkspace(await send({ type: "workspaces" }), (open) => choice.choose({
        title: "Which folder should this chat work in?", hint: "Your editor has more than one folder open. This chat stays in the one you choose, whichever window you use later.", options: open,
      }));
      if (picked.path) bindings.setPending(picked.path);
      return picked;
    },
    /** Keep the chat's folder in step with the page: remember it once the chat has an id, give an older chat the folder it has now. */
    async settle() {
      if (settling || !state.started || !provider.conversationKey()) return;
      bindings.commit();
      if (Date.now() - settledAt < 5000) return;
      settledAt = Date.now();
      settling = true;
      try {
        if (!bindings.current()) {
          await workspace.refresh();
          if (workspaceInfo && workspaceInfo.path) bindings.bind(workspaceInfo.path);
        } else if (!workspaceInfo || workspaceInfo.path !== bindings.current()) await workspace.refresh();
      } finally { settling = false; }
    },
    async refresh() {
      state.filesChangedAt = Date.now(); // another folder: the files listed before are not its files
      const feedback = await runner.run({ tool: "get_workspace_info" });
      try {
        const info = JSON.parse(withoutResultHeader(feedback));
        workspaceInfo = { name: info.name, path: info.path, git: !!info.is_git_repository };
      } catch { workspaceInfo = null; } // a target without that command: the prompt then speaks of "this folder"
    },
  };

  /** The instructions for this workspace and these settings: one definition for the start and for any re-statement. */
  const systemPrompt = () => buildSystemPrompt({
    workspace: workspaceInfo,
    targetName: serverDirectory.name(settings.target()),
    customPrompt: serverDirectory.customPrompt,
    skills: skills.enabled,
  });

  /** The command list the model is reminded of every so often, scoped to the selected target. */
  const reminderText = () => toolsReminder(catalogue.active(), serverDirectory.name(settings.target()), settings.target());

  return { bridge, session, catalogue, confirm, runner, manual, skills, workspace, systemPrompt, reminderText };
}
