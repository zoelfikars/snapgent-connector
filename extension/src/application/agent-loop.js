// SPDX-License-Identifier: GPL-3.0-or-later
// The agent loop: read the model's reply, run the command it contains, feed the
// result back, repeat until the model answers in plain text or the user stops.
//
// This class only ORCHESTRATES. What to do with each kind of reply lives in
// domain/agent/turn-policy; how a tool runs lives in ToolRunner; how things are
// drawn lives behind the `view` port.

import { planTurn } from "../domain/agent/turn-policy.js";
import { FEEDBACK } from "../domain/prompt/feedback.js";
import { DEFAULT_PROMPT_CHARS } from "../domain/prompt/budget.js";
import { BatchRunner } from "./batch-runner.js";
import { StallWatchdog } from "./stall-watchdog.js";

const WATCHDOG_STALL_MESSAGE = ["Agent stopped waiting", "No progress for 3 min. Send continue to resume."];

export class AgentLoop {
  /**
   * @param {{
   *   chat: import("./ports.js").ChatTurnsPort,
   *   view: import("./ports.js").LoopViewPort,
   *   lifecycle: import("./ports.js").LoopLifecyclePort,
   *   visibility: import("./ports.js").VisibilityPort,
   *   runner: { run: (call: object, options?: { budgetChars?: number, jobKey?: string }) => Promise<string> },
   *   tools: import("./ports.js").LoopToolsPort,
   *   memory: { executed: (item: object) => void },
   *   outbox: { prepare: (text: string) => string, reserve?: () => number },
   *   budget?: { limit: () => number, calls?: () => number, sent?: (chars: number) => number, tooLong?: (chars: number) => void },
   *   parts?: import("./part-queue.js").PartQueue,   // the rest of an answer that did not fit in one message
   *   jobs?: { begin: (item: object) => Promise<string>, end: (item: object) => void },  // names a batch, so a reload can pick it up again
   *   reminder: import("./tool-reminder.js").ToolReminder,
   *   activity: { signature: () => string, isPaused: () => boolean },
   *   timers: import("./ports.js").Timers,
   *   now?: () => number,
   *   displayName: () => string,
   *   diag?: (event: string, data?: object) => void,
   * }} deps
   */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag || (() => {});
    this._budget = deps.budget || { limit: () => DEFAULT_PROMPT_CHARS };
    this._batch = new BatchRunner({ ...deps, budget: this._budget, park: (scope, extra) => this._parkWhileHidden(scope, extra), diag: this._diag });
  }

  /** @param {*} initialBase handle of the turn count to wait past (see ChatTurnsPort.next) */
  async run(initialBase) {
    const { lifecycle } = this._d;
    let base = initialBase;
    let truncCount = 0;
    lifecycle.start();
    this._diag("loop.start", { base });
    const watchdog = this._newWatchdog();
    watchdog.start();
    try {
      while (!lifecycle.isStopped()) {
        if (!(await this._parkWhileHidden("loop"))) break;

        const res = await this._d.chat.next(base);
        this._diag("response", { kind: res.kind, calls: res.calls ? res.calls.map((call) => call.tool) : undefined, text: res.kind === "text" ? String(res.text || "").slice(0, 200) : undefined });
        if (lifecycle.isStopped() || res.kind === "stopped") break;

        // The model answered the first part of a longer message: its short reply is not the end, the next part is due.
        if ((res.kind === "text" || res.kind === "tool") && this._d.parts && this._d.parts.pending()) {
          base = await this._sendNextPart(res.kind === "tool");
          continue;
        }

        const plan = planTurn(res, {
          displayName: this._d.displayName(),
          truncCount,
          isHalted: () => this._d.chat.isHalted(res.item),
        });
        truncCount = plan.truncCount;

        if (plan.type === "end") {
          // The site refused a message as too long: remember how big that one was, so the next ones stay smaller.
          if (res.kind === "too_long" && this._budget.tooLong) this._budget.tooLong(this._batch.lastSentChars);
          this._announce(plan);
          break;
        }
        if (plan.type === "skip") continue;
        if (plan.type === "resume-truncated") {
          base = await this._resumeTruncated(base);
          continue;
        }
        if (plan.type === "parse-error") {
          if (this._d.view.progress) this._d.view.progress("The command could not be read · asking the AI to send it again…");
          base = await this._d.chat.submit(plan.feedback);
          continue;
        }
        const outcome = await this._batch.run(res.item, plan.calls);
        if (outcome.halted) break;
        base = outcome.base;
      }
    } catch (e) {
      const message = String((e && e.message) || e);
      this._diag("loop.error", { msg: message });
      this._d.view.banner("warn", "Internal loop error", message);
    } finally {
      watchdog.stop();
      if (this._d.parts) this._d.parts.clear();
      lifecycle.end();
      this._diag("loop.end");
    }
  }

  // ── pieces ──────────────────────────────────────────────────────────────

  /** Never read/parse/execute off-screen. Returns false only if the user stopped while parked. */
  async _parkWhileHidden(scope, extra) {
    const { visibility, lifecycle } = this._d;
    if (!visibility.isHidden() || lifecycle.isStopped()) return true;
    this._diag(scope === "loop" ? "loop.waitVisible" : "tool.parkBeforeDispatch", extra);
    if (scope === "loop") this._d.view.keepCover();
    if (!(await visibility.waitUntilVisible()) || lifecycle.isStopped()) return false;
    if (scope === "loop") this._diag("loop.visibleAgain");
    return true;
  }

  /** Send the next part of a message that was split. Commands the model sent meanwhile are not run: it was told to wait. */
  async _sendNextPart(ignoredCommands) {
    const { text, label } = this._d.parts.next();
    this._diag("parts.next", { label, ignoredCommands });
    if (this._d.view.progress) this._d.view.progress(label);
    this._batch.lastSentChars = text.length;
    const note = ignoredCommands ? "[The commands in your last reply were not run: wait for the last part, then send them again.]\n\n" : "";
    return this._d.chat.submit(note + text);
  }

  _announce(plan) {
    if (plan.diag) this._diag(plan.diag);
    if (plan.banner) this._d.view.banner(plan.banner.level, plan.banner.title, plan.banner.text);
  }

  /** The reply was cut by a length limit: continue the SAME turn, natively if possible. */
  async _resumeTruncated(base) {
    if (await this._d.chat.resumeTruncated()) {
      this._diag("truncated.continued");
      return base; // same turn resumes (base unchanged)
    }
    this._diag("truncated.sendFallback");
    this._d.view.toast("Resuming…");
    return this._d.chat.submit(FEEDBACK.truncated);
  }

  _newWatchdog() {
    const { activity, timers, view, lifecycle } = this._d;
    return new StallWatchdog({
      signature: activity.signature,
      isPaused: activity.isPaused,
      timers,
      now: this._d.now,
      onStall: (signature) => {
        this._diag("loop.watchdog", { sig: signature });
        view.banner("warn", ...WATCHDOG_STALL_MESSAGE);
        lifecycle.halt();
      },
    });
  }
}
