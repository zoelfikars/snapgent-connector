// SPDX-License-Identifier: GPL-3.0-or-later
// The agent loop: read the model's reply, run the command it contains, feed the
// result back, repeat until the model answers in plain text or the user stops.
//
// This class only ORCHESTRATES. What to do with each kind of reply lives in
// domain/agent/turn-policy; how a tool runs lives in ToolRunner; how things are
// drawn lives behind the `view` port.

import { planTurn } from "../domain/agent/turn-policy.js";
import { describeOutcome } from "../domain/tools/outcome.js";
import { argSummary, callBody } from "../domain/tools/result-summary.js";
import { bareToolName } from "../domain/tools/names.js";
import { FEEDBACK } from "../domain/prompt/feedback.js";
import { StallWatchdog } from "./stall-watchdog.js";

const WATCHDOG_STALL_MESSAGE = ["Agent stopped waiting", "No progress for 3 min. Send continue to resume."];

export class AgentLoop {
  /**
   * @param {{
   *   chat: import("./ports.js").ChatTurnsPort,
   *   view: import("./ports.js").LoopViewPort,
   *   lifecycle: import("./ports.js").LoopLifecyclePort,
   *   visibility: import("./ports.js").VisibilityPort,
   *   runner: { run: (call: object) => Promise<string> },
   *   tools: import("./ports.js").LoopToolsPort,
   *   memory: { executed: (item: object) => void },
   *   outbox: { prepare: (text: string) => string },
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
        this._diag("response", { kind: res.kind });
        if (lifecycle.isStopped() || res.kind === "stopped") break;

        const plan = planTurn(res, {
          displayName: this._d.displayName(),
          truncCount,
          isHalted: () => this._d.chat.isHalted(res.item),
          isLearnedImageTool: (name) => this._d.tools.isImageTool(bareToolName(name)),
        });
        truncCount = plan.truncCount;

        if (plan.type === "end") { this._announce(plan); break; }
        if (plan.type === "skip") continue;
        if (plan.type === "resume-truncated") {
          base = await this._resumeTruncated(base);
          continue;
        }
        if (plan.type === "parse-error") {
          if (plan.chip) this._d.view.parseErrorChip(plan.chip);
          base = await this._d.chat.submit(plan.feedback);
          continue;
        }
        if (plan.type === "feedback") {
          base = await this._d.chat.submit(plan.feedback);
          continue;
        }
        // plan.type === "run"
        const outcome = await this._runCall(res.item, plan.call, plan.category);
        if (outcome.halted) break;
        base = outcome.base;
      }
    } catch (e) {
      const message = String((e && e.message) || e);
      this._diag("loop.error", { msg: message });
      this._d.view.banner("warn", "Internal loop error", message);
    } finally {
      watchdog.stop();
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

  async _runCall(item, call, category) {
    const { view, tools, memory, lifecycle, runner } = this._d;
    this._diag("tool.runCat", { name: call.tool, category });

    // Park BEFORE painting the chip or marking the turn dispatched, so a long
    // minimize neither shows a bogus running time nor loses the command on reload.
    if (!(await this._parkWhileHidden("tool", { name: call.tool }))) return { halted: true };

    view.toolRunning(item, call, category, { arg: argSummary(call), body: callBody(call) });
    memory.executed(item);
    this._diag("tool.start", { name: call.tool });
    const feedback = await runner.run(call);
    view.toolFinished();
    this._diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });

    if (lifecycle.isStopped()) {
      // Settle the spinning chip so it does not look stuck, and mark the turn so it is never repainted done.
      view.toolStopped(item, call, category);
      return { halted: true };
    }

    const outcome = describeOutcome(feedback);
    this._diag("tool.result", {
      name: call.tool, isErr: outcome.isErr, phase: outcome.phase, summary: outcome.summary,
      lineCount: outcome.lineCount, firstLine: outcome.firstLine, lastLine: outcome.lastLine,
    });

    // A tool that actually returned an image becomes a "screen" chip, and is remembered for next time.
    const hasImages = tools.hasPendingImages();
    if (hasImages) tools.learnImageTool(call.tool);
    view.toolSettled(item, call, { ...outcome, category: hasImages ? "screen" : category });

    let toSend = feedback;
    const reminderDue = this._d.reminder.onResult({ isErr: outcome.isErr, tool: call.tool, hasCatalogue: tools.hasCatalogue() });
    if (reminderDue) {
      toSend += tools.reminderText();
      this._diag("tools.reminder");
    }
    // The result becomes a turn: it counts toward the system-prompt re-statement budget and may carry it.
    toSend = this._d.outbox.prepare(toSend);
    const images = tools.takePendingImages();
    this._diag("images.consumed", { count: images ? images.length : 0 });
    return { base: await this._d.chat.submit(toSend, images) };
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
