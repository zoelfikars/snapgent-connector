// SPDX-License-Identifier: GPL-3.0-or-later
// Starts an agent session on a blank chat: verify the target is usable, send the
// system prompt, let the model do the list_commands handshake, then mark the
// session started. Orchestration only; the rules live in domain/agent/session-start.

import {
  WORKSPACE_PROBE_TOOL, checkStartPreconditions, handshakeUnavailable, isHandshake, probeSucceeded, workspaceRequiredBanner,
} from "../domain/agent/session-start.js";
import { unreadableBanner } from "../domain/agent/turn-policy.js";
import { bareToolName } from "../domain/tools/names.js";

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
   *   layout?: import("./ports.js").LayoutCheckPort,   // verifies the adapter understands the page
   *   view: import("./ports.js").StartViewPort,
   *   isStopped: () => boolean,
   *   diag?: (event: string, data?: object) => void,
   * }} deps
   */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag || (() => {});
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

  /** Send the prompt; if the model answers with list_commands as instructed, run it and wait for "ready". */
  async _handshake(alive) {
    const { chat, runner, view, target, catalogue, isStopped } = this._d;
    const base = await chat.submit(this._d.systemPrompt());
    if (!alive()) return false;
    await this._checkSentMessageIsRecognised();
    view.showStartingChip(); // the animated "Starting Up" chip, immediately
    const first = await chat.next(base);
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
      const feedback = await runner.run(first.calls[0]);
      if (handshakeUnavailable(feedback)) view.handshake(first.item, "err", `${target.name()} unavailable`);
      else view.handshake(first.item, "done", `${catalogue.active().length} commands`);
      const ready = await chat.next(await chat.submit(feedback));
      if (!alive()) return false;
      if (isStopped() || ready.kind === "stopped") { this._diag("start.aborted", { kind: ready.kind }); return false; }
    }
    return true;
  }
}
