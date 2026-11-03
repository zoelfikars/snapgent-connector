// SPDX-License-Identifier: GPL-3.0-or-later
// The agent loop: read the model's reply, run the command it contains, feed the
// result back, repeat until the model answers in plain text or the user stops.
//
// This class only ORCHESTRATES. What to do with each kind of reply lives in
// domain/agent/turn-policy; how a tool runs lives in ToolRunner; how things are
// drawn lives behind the `view` port.

import { planTurn } from "../domain/agent/turn-policy.js";
import { toolCategory } from "../domain/tools/category.js";
import { describeOutcome } from "../domain/tools/outcome.js";
import { argSummary, callBody, runningLabel } from "../domain/tools/result-summary.js";
import { bareToolName } from "../domain/tools/names.js";
import { FEEDBACK } from "../domain/prompt/feedback.js";
import { DEFAULT_PROMPT_CHARS, MAX_BATCH_CALLS, MIN_CALL_CHARS, callShare, composeBatch, sessionIsLarge, trimMiddle } from "../domain/prompt/budget.js";
import { StallWatchdog } from "./stall-watchdog.js";

const WATCHDOG_STALL_MESSAGE = ["Agent stopped waiting", "No progress for 3 min. Send continue to resume."];

export class AgentLoop {
  /**
   * @param {{
   *   chat: import("./ports.js").ChatTurnsPort,
   *   view: import("./ports.js").LoopViewPort,
   *   lifecycle: import("./ports.js").LoopLifecyclePort,
   *   visibility: import("./ports.js").VisibilityPort,
   *   runner: { run: (call: object, options?: { budgetChars?: number }) => Promise<string> },
   *   tools: import("./ports.js").LoopToolsPort,
   *   memory: { executed: (item: object) => void },
   *   outbox: { prepare: (text: string) => string, reserve?: () => number },
   *   budget?: { limit: () => number, sent?: (chars: number) => number, tooLong?: (chars: number) => void },
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
    this._lastSentChars = 0;
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

        const plan = planTurn(res, {
          displayName: this._d.displayName(),
          truncCount,
          isHalted: () => this._d.chat.isHalted(res.item),
          isLearnedImageTool: (name) => this._d.tools.isImageTool(bareToolName(name)),
        });
        truncCount = plan.truncCount;

        if (plan.type === "end") {
          // The site refused a message as too long: remember how big that one was, so the next ones stay smaller.
          if (res.kind === "too_long" && this._budget.tooLong) this._budget.tooLong(this._lastSentChars);
          this._announce(plan);
          break;
        }
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
        // plan.type === "run": one command, or several written in the same reply
        const outcome = await this._runBatch(res.item, plan.calls || [plan.call], plan.category);
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

  /** Room in the next message for what is added AFTER the results: the command reminder and a re-stated system prompt. */
  _reserved() {
    const { reminder, tools, outbox } = this._d;
    let reserved = 0;
    if (typeof reminder.willBeDue === "function" && reminder.willBeDue({ hasCatalogue: tools.hasCatalogue() })) reserved += tools.reminderText().length;
    if (typeof outbox.reserve === "function") reserved += outbox.reserve();
    return reserved;
  }

  /**
   * Run every command of one reply in order and answer with ONE message. The message has a size limit: each command
   * gets an even share of what is left, and tools that can limit their own output read or keep only what fits. A
   * command that would only get a sliver is not run; neither is anything after a failure, an image, or a stop.
   */
  async _runBatch(item, calls, firstCategory) {
    const { tools, reminder } = this._d;
    const batch = calls.slice(0, MAX_BATCH_CALLS);
    const notRun = calls.slice(MAX_BATCH_CALLS).map((call) => ({ tool: call.tool, why: `at most ${MAX_BATCH_CALLS} commands per reply` }));
    const results = [];
    const room = Math.max(MIN_CALL_CHARS, this._budget.limit() - this._reserved());
    let used = 0;
    let failed = false;
    let last = batch[0];

    for (let index = 0; index < batch.length; index++) {
      const call = batch[index];
      const remaining = room - used;
      // `from` is the first command that did NOT run: this one when it was skipped, the next one when it ran and failed.
      const skipRest = (why, from = index) => notRun.unshift(...batch.slice(from).map((c) => ({ tool: c.tool, why })));
      if (index > 0 && remaining < MIN_CALL_CHARS) { skipRest("the message size limit was reached"); break; }

      const step = await this._runCall(item, call, index === 0 ? firstCategory : null, { budgetChars: callShare(remaining, batch.length - index), step: { index, total: batch.length } });
      if (step.halted) return { halted: true };
      last = call;
      const text = step.feedback.length > remaining ? trimMiddle(step.feedback, remaining, "the results") : step.feedback;
      results.push(text);
      used += text.length + 2;
      failed = failed || step.isErr;
      this._diag("batch.step", { name: call.tool, index, of: batch.length, chars: text.length, left: room - used });

      const why = step.isErr ? "stopped after the error above" : step.hasImages ? "an image result is sent on its own" : null;
      if (why && index < batch.length - 1) { skipRest(why, index + 1); break; }
    }

    if (this._d.view.progress) this._d.view.progress(""); // back to the plain "working" label while the AI answers
    let toSend = composeBatch(results, notRun);
    if (toSend.length > room) toSend = trimMiddle(toSend, room, "the results");
    if (reminder.onResult({ isErr: failed, tool: last.tool, hasCatalogue: tools.hasCatalogue() })) {
      toSend += tools.reminderText();
      this._diag("tools.reminder");
    }
    // The result becomes a turn: it counts toward the system-prompt re-statement budget and may carry it.
    toSend = this._d.outbox.prepare(toSend);
    const images = tools.takePendingImages();
    this._diag("images.consumed", { count: images ? images.length : 0 });
    this._lastSentChars = toSend.length;
    if (this._budget.sent && sessionIsLarge(this._budget.sent(toSend.length), this._budget.limit())) this._d.view.toast("This chat is getting large. A new chat will be cheaper.");
    return { base: await this._d.chat.submit(toSend, images) };
  }

  /** One command: paint it, run it, paint the outcome. `category` is null for later commands of a batch (recomputed). */
  async _runCall(item, call, category, { budgetChars, step } = {}) {
    const { view, tools, memory, lifecycle, runner } = this._d;
    const kind = category || (tools.isImageTool(bareToolName(call.tool)) ? "screen" : toolCategory(call.tool));
    this._diag("tool.runCat", { name: call.tool, category: kind });

    // Park BEFORE painting the chip or marking the turn dispatched, so a long
    // minimize neither shows a bogus running time nor loses the command on reload.
    if (!(await this._parkWhileHidden("tool", { name: call.tool }))) return { halted: true };

    // Tell the user WHICH command is running (shown on the composer cover), with its place in a batch.
    if (view.progress) view.progress(runningLabel(call, step));
    view.toolRunning(item, call, kind, { arg: argSummary(call), body: callBody(call) });
    memory.executed(item);
    this._diag("tool.start", { name: call.tool });
    const feedback = await runner.run(call, { budgetChars });
    view.toolFinished();
    this._diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });

    if (lifecycle.isStopped()) {
      // Settle the spinning chip so it does not look stuck, and mark the turn so it is never repainted done.
      view.toolStopped(item, call, kind);
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
    view.toolSettled(item, call, { ...outcome, category: hasImages ? "screen" : kind });
    return { feedback, isErr: outcome.isErr, hasImages };
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
