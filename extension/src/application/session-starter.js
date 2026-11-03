// SPDX-License-Identifier: GPL-3.0-or-later
// Starts an agent session on a blank chat: verify the target is usable, send the
// system prompt, let the model do the list_commands handshake, then mark the
// session started. Orchestration only; the rules live in domain/agent/session-start.

import {
  HANDSHAKE_EXTRA_NOTE, WORKSPACE_PROBE_TOOL, checkStartPreconditions, handshakeUnavailable, isHandshake, probeSucceeded, workspaceRequiredBanner,
} from "../domain/agent/session-start.js";
import { unreadableBanner } from "../domain/agent/turn-policy.js";
import { bareToolName } from "../domain/tools/names.js";
import { trimMiddle } from "../domain/prompt/budget.js";

// The project tree handed over at the start may take this share of one message.
const TREE_SHARE = 0.2;
const AUTO_LIST_NOTE = "\n\n(System note: the command list was fetched for you automatically. Do not reply to it except to confirm you are ready for the user's task.)";

export class SessionStarter {
  /**
   * @param {{
   *   session: import("./ports.js").SessionLifecyclePort,
   *   page: { isEmpty: () => boolean, isStarted: () => boolean, ensureComposerReady: (reason: string) => Promise<{ready: boolean}>, displayName: () => string },
   *   target: { id: () => string, name: () => string, bridgeConnected: () => boolean, serverAlive: () => boolean },
   *   catalogue: Pick<import("./tool-catalogue.js").ToolCatalogue, "ensure"|"active">,
   *   callTool: (name: string, args: object, timeoutMs: number) => Promise<object>,
   *   skills: { load: () => Promise<void> },
   *   systemPrompt: () => string,
   *   chat: { submit: (text: string) => Promise<*>, next: (base: *) => Promise<object> },
   *   runner: { run: (call: object) => Promise<string> },
   *   initialContext?: { limit: () => number },        // when present, the project tree rides on the handshake result (within this message size)
   *   layout?: import("./ports.js").LayoutCheckPort,   // verifies the adapter understands the page
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
      if (!(await this._handshake(alive))) return;
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

    if (target.id() === "vscode") {
      const probeTool = catalogue.active().find((tool) => bareToolName(tool.name) === WORKSPACE_PROBE_TOOL);
      const probe = await callTool(probeTool.name, { path: "." }, 5000);
      if (!alive()) return false;
      if (!probeSucceeded(probe)) {
        const banner = workspaceRequiredBanner();
        view.banner("warn", banner.title, banner.text);
        return false;
      }
      this._tree = typeof probe.text === "string" ? probe.text.trim() : "";
    }

    const mode = await page.ensureComposerReady("startup");
    if (!alive()) return false;
    if (!mode.ready) { view.banner("warn", `${page.displayName()} mode not ready`, "Try a new chat or reload."); return false; }

    if (target.id() === "vscode") await skills.load();
    return alive();
  }

  /**
   * After sending, the prompt must show up as a user turn that carries the session marker; that is
   * how it gets hidden behind the "Starting Up" chip. If it does not, the adapter does not fully
   * understand the page: warn (and log what the page looks like) but let the start continue.
   */
  async _checkSentMessageIsRecognised() {
    const { layout, view, page } = this._d;
    if (!layout || (await layout.sentMessageVisible())) return;
    this._diag("layout.sentMissing", layout.describe());
    view.banner("warn", `${page.displayName()} page not fully recognised`, "Your message was sent but not detected as a user turn, so hiding it may not work.");
  }

  /** The workspace tree the start already fetched, for the model to plan its first reads from. Empty when not wanted. */
  _treeBlock() {
    const { initialContext } = this._d;
    if (!initialContext || !this._tree) return "";
    const tree = trimMiddle(this._tree, Math.floor(initialContext.limit() * TREE_SHARE), "the project tree");
    return "\n\nProject tree for reference (junk folders excluded). Do not act on it yet: wait for the user's task, then choose the files you need from it " +
      "and read several together with one read_files call.\n" + tree;
  }

  /** Send the handshake result and wait for the model's "ready". False when the start was abandoned meanwhile. */
  async _deliver(feedback, alive) {
    const { chat, isStopped } = this._d;
    const base = await chat.submit(feedback);
    this._diag("start.resultSent", { chars: feedback.length });
    const ready = await chat.next(base);
    this._diag("start.readyReply", { kind: ready.kind, calls: ready.calls ? ready.calls.map((call) => call.tool) : undefined });
    if (!alive()) return false;
    if (isStopped() || ready.kind === "stopped") { this._diag("start.aborted", { kind: ready.kind }); return false; }
    return true;
  }

  /** Send the prompt; if the model answers with list_commands as instructed, run it and wait for "ready". */
  async _handshake(alive) {
    const { chat, runner, view, target, catalogue, isStopped } = this._d;
    const base = await chat.submit(this._d.systemPrompt());
    if (!alive()) return false;
    await this._checkSentMessageIsRecognised();
    view.showStartingChip(); // the animated "Starting Up" chip, immediately
    this._diag("start.promptSent");
    const first = await chat.next(base);
    this._diag("start.firstReply", { kind: first.kind, text: first.kind === "text" ? String(first.text || "").slice(0, 300) : undefined, calls: first.calls ? first.calls.map((call) => call.tool) : undefined, alive: alive() });
    if (!alive()) return false;
    if (first.kind === "unreadable") {
      // Nothing we do next can work if replies cannot be read: say so instead of hanging.
      const banner = unreadableBanner(this._d.page.displayName());
      view.banner(banner.level, banner.title, banner.text);
      return false;
    }
    // The user halted the bootstrap: do NOT declare the session ready, so "Start" stays available.
    if (isStopped() || first.kind === "stopped") { this._diag("start.aborted", { kind: first.kind }); return false; }

    if (isHandshake(first)) {
      view.handshake(first.item, "run", "");
      const answer = await runner.run(first.calls[0]);
      this._diag("start.handshakeRan", { chars: answer.length, tree: this._tree.length });
      const unavailable = handshakeUnavailable(answer);
      if (unavailable) view.handshake(first.item, "err", `${target.name()} unavailable`);
      else view.handshake(first.item, "done", `${catalogue.active().length} commands`);
      const extra = first.calls.length > 1 ? HANDSHAKE_EXTRA_NOTE : "";
      return this._deliver((unavailable ? answer : answer + this._treeBlock()) + extra, alive);
    }
    // The model answered in plain words instead of asking for the command list. Without the list it cannot work, and
    // nothing would ever run it, so fetch it here and hand it over together with the tree.
    if (first.kind === "text") {
      this._diag("start.noHandshake", { kind: first.kind, text: String(first.text || "").slice(0, 300) });
      const answer = await runner.run({ tool: "list_commands", arguments: { server: target.id() } });
      if (handshakeUnavailable(answer)) return true;
      return this._deliver(answer + this._treeBlock() + AUTO_LIST_NOTE, alive);
    }
    this._diag("start.noHandshake", { kind: first.kind });
    return true;
  }
}
