// SPDX-License-Identifier: GPL-3.0-or-later
// Starts an agent session on a blank chat: verify the target is usable, then send ONE message that already holds everything the model
// would otherwise ask for one command at a time (the workspace, the command list, the project tree) and wait for its short answer.
// Orchestration only; the rules live in domain/agent/session-start.

import { WORKSPACE_PROBE_TOOL, checkStartPreconditions, handshakeUnavailable, isWorkspaceServer, probeSucceeded, workspaceRequiredBanner } from "../domain/agent/session-start.js";
import { cleanContext } from "../domain/prompt/context-file.js";
import { withoutResultHeader } from "../domain/tools/result-marker.js";
import { unreadableBanner } from "../domain/agent/turn-policy.js";
import { bareToolName } from "../domain/tools/names.js";
import { trimMiddle } from "../domain/prompt/budget.js";

// The project tree in the start message may take this share of one message.
const TREE_SHARE = 0.2;

export class SessionStarter {
  /**
   * @param {{
   *   session: import("./ports.js").SessionLifecyclePort,
   *   page: { isEmpty: () => boolean, isStarted: () => boolean, ensureComposerReady: (reason: string) => Promise<{ready: boolean}>, displayName: () => string },
   *   target: { id: () => string, name: () => string, bridgeConnected: () => boolean, serverAlive: () => boolean },
   *   catalogue: Pick<import("./tool-catalogue.js").ToolCatalogue, "ensure"|"active">,
   *   callTool: (name: string, args: object, timeoutMs: number) => Promise<object>,
   *   skills: { load: () => Promise<void> },
   *   workspace: { refresh: () => Promise<void>, choose?: () => Promise<{ path?: string, none?: boolean, cancelled?: boolean, error?: string }> },
   *     // refresh learns which folder is the workspace (the prompt names it); choose settles which folder THIS chat works in, asking the user when VS Code has several
   *   contextFiles?: () => Promise<string[]>,        // instruction files to look for, in order; the first one found is read
   *   startMessage: (parts: { commands: string, tree: string, context?: { name: string, text: string } | null }) => string,
   *   chat: { submit: (text: string) => Promise<*>, next: (base: *) => Promise<object> },
   *   runner: { run: (call: object) => Promise<string> },
   *   initialContext?: { limit: () => number },        // when present, the project tree is part of the start message (within this message size)
   *   layout?: import("./ports.js").LayoutCheckPort,   // verifies the engine understands the page
   *   view: import("./ports.js").StartViewPort,
   *   isStopped: () => boolean,
   *   diag?: (event: string, data?: object) => void,
   * }} deps
   */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag || (() => {});
    this._tree = "";
  }

  async start() {
    const { session, page, view } = this._d;
    if (!session.canStart()) return;
    // "Start" is allowed only on a blank conversation: opening an existing one must never bootstrap.
    if (!page.isEmpty() && !page.isStarted()) { view.toast("Use an empty chat."); return; }
    const alive = session.begin(); // false once superseded (the user opened another chat) or aborted
    try {
      if (!(await this._ready(alive))) return;
      if (!(await this._introduce(alive))) return;
      session.markStarted();
      view.toast("Agent on.");
    } catch (e) {
      this._diag("start.error", { msg: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 300) });
      if (alive()) view.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      session.end(alive);
    }
  }

  /** Target usable, composer ready, skills loaded. Reports why (banner) and returns false when not. */
  async _ready(alive) {
    const { catalogue, target, view, page, callTool, skills } = this._d;
    await catalogue.ensure(true); // boot: always a fresh catalogue (the TTL then covers the model's own list calls)
    if (!alive()) return false;

    const problem = checkStartPreconditions({
      target: target.id(), targetName: target.name(), bridgeConnected: target.bridgeConnected(),
      serverAlive: target.serverAlive(), toolNames: catalogue.active().map((tool) => tool.name),
    });
    if (problem) { view.banner("warn", problem.title, problem.text); return false; }

    const workspaceTarget = isWorkspaceServer(target.id(), catalogue.active().map((tool) => tool.name));
    if (workspaceTarget && this._d.workspace.choose) {
      const choice = await this._d.workspace.choose();
      if (!alive()) return false;
      if (choice.cancelled) { view.toast("Start cancelled."); return false; }
      if (choice.error) { view.banner("warn", "VS Code workspace", choice.error); return false; }
      if (choice.none) { const banner = workspaceRequiredBanner(); view.banner("warn", banner.title, banner.text); return false; }
      this._diag("start.workspace", { path: choice.path });
    }

    if (workspaceTarget) {
      const probeTool = catalogue.active().find((tool) => bareToolName(tool.name) === WORKSPACE_PROBE_TOOL);
      const probe = await callTool(probeTool.name, { path: "." }, 5000);
      if (!alive()) return false;
      if (!probeSucceeded(probe)) {
        const banner = workspaceRequiredBanner();
        view.banner("warn", banner.title, banner.text);
        return false;
      }
      this._tree = typeof probe.text === "string" ? probe.text.trim() : "";

      this._context = null; // a next start in another folder (or with the file gone) must not reuse this chat's instructions
      const contextNames = this._d.contextFiles ? await this._d.contextFiles() : [];
      for (const name of contextNames) {
        const result = await this._d.callTool("read_files", { paths: [name], max_total_chars: 10000 }, 3000);
        if (result && result.ok && typeof result.text === "string" && !result.text.includes("File not found")) {
          this._context = { name, text: cleanContext(result.text) };
          break;
        }
      }
    }

    const mode = await page.ensureComposerReady("startup");
    if (!alive()) return false;
    if (!mode.ready) { view.banner("warn", `${page.displayName()} mode not ready`, "Try a new chat or reload."); return false; }

    if (workspaceTarget) await skills.load();
    return alive();
  }

  /** After sending, the message must show up as a user turn. If it does not, the engine does not fully understand the page: warn, log what it looks like, and carry on. */
  async _checkSentMessageIsRecognised() {
    const { layout, view, page } = this._d;
    if (!layout || (await layout.sentMessageVisible())) return;
    this._diag("layout.sentMissing", layout.describe());
    view.banner("warn", `${page.displayName()} page not fully recognised`, "Your message was sent but not detected as a user turn.");
  }

  /** The tree the start already fetched, cut to its share of the message. Empty when not wanted. */
  _treeBlock() {
    const { initialContext } = this._d;
    if (!initialContext || !this._tree) return "";
    return trimMiddle(this._tree, Math.floor(initialContext.limit() * TREE_SHARE), "the project tree");
  }

  /** Send the start message and wait for the model's "understood". False when the start was abandoned meanwhile. */
  async _introduce(alive) {
    const { chat, runner, view, target, workspace, isStopped } = this._d;
    await workspace.refresh();
    const listed = await runner.run({ tool: "list_commands", arguments: { server: target.id() } });
    if (handshakeUnavailable(listed)) { view.banner("warn", `${target.name()} unavailable`, "Is the server online?"); return false; }
    if (!alive()) return false;

    const message = this._d.startMessage({ commands: withoutResultHeader(listed), tree: this._treeBlock(), context: this._context });
    const base = await chat.submit(message);
    this._diag("start.sent", { chars: message.length, tree: this._tree.length });
    if (!alive()) return false;
    await this._checkSentMessageIsRecognised();

    const reply = await chat.next(base);
    this._diag("start.reply", { kind: reply.kind, text: reply.kind === "text" ? String(reply.text || "").slice(0, 200) : undefined, alive: alive() });
    if (!alive()) return false;
    if (reply.kind === "unreadable") {
      // Nothing we do next can work if replies cannot be read: say so instead of hanging.
      const banner = unreadableBanner(this._d.page.displayName());
      view.banner(banner.level, banner.title, banner.text);
      return false;
    }
    // The user halted the start: do NOT declare the session ready, so "Start" stays available.
    if (isStopped() || reply.kind === "stopped") { this._diag("start.aborted", { kind: reply.kind }); return false; }
    return true;
  }
}
