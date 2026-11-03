// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the commands of ONE reply and answers with ONE message (see AgentLoop, which decides when to).
//
// The message has a size limit: each command gets an even share of what is left, tools that can limit their own
// output do, and a command that would only get a sliver is not run. Nothing after a failure, an image or a stop runs
// either. Every command carries a job key (batch id + place + content), so when the page is reloaded mid-batch and the
// reply is run again, commands that already ran are answered from the server's record instead of running twice.

import { toolCategory } from "../domain/tools/category.js";
import { describeOutcome } from "../domain/tools/outcome.js";
import { argSummary, callBody, runningLabel } from "../domain/tools/result-summary.js";
import { bareToolName } from "../domain/tools/names.js";
import { jobKey } from "../domain/tools/job-key.js";
import { MAX_BATCH_CALLS, MIN_CALL_CHARS, callShare, composeBatch, sessionIsLarge, trimMiddle } from "../domain/prompt/budget.js";

export class BatchRunner {
  /** @param {object} deps  the AgentLoop's deps, plus `park(scope, extra)` (wait while the tab is hidden) and `diag` */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag;
    this._budget = deps.budget;
    this.lastSentChars = 0;
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
  async run(item, calls, firstCategory) {
    const { tools, reminder } = this._d;
    const batch = calls.slice(0, MAX_BATCH_CALLS);
    const notRun = calls.slice(MAX_BATCH_CALLS).map((call) => ({ tool: call.tool, why: `at most ${MAX_BATCH_CALLS} commands per reply` }));
    const results = [];
    const room = Math.max(MIN_CALL_CHARS, this._budget.limit() - this._reserved());
    const batchId = this._d.jobs ? await this._d.jobs.begin(item) : null;
    let used = 0;
    let failed = false;
    let last = batch[0];

    for (let index = 0; index < batch.length; index++) {
      const call = batch[index];
      const remaining = room - used;
      // `from` is the first command that did NOT run: this one when it was skipped, the next one when it ran and failed.
      const skipRest = (why, from = index) => notRun.unshift(...batch.slice(from).map((c) => ({ tool: c.tool, why })));
      if (index > 0 && remaining < MIN_CALL_CHARS) { skipRest("the message size limit was reached"); break; }

      const step = await this._runCall(item, call, index === 0 ? firstCategory : null, {
        jobKey: batchId && jobKey(batchId, index, call), budgetChars: callShare(remaining, batch.length - index), step: { index, total: batch.length } });
      if (step.halted) { this._end(item); return { halted: true }; }
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
    this.lastSentChars = toSend.length;
    if (this._budget.sent && sessionIsLarge(this._budget.sent(toSend.length), this._budget.limit())) this._d.view.toast("This chat is getting large. A new chat will be cheaper.");
    const base = await this._d.chat.submit(toSend, images);
    this._end(item);
    return { base };
  }

  /** The batch is over (answered, or stopped): the next run of this reply is a new batch, not a resumption. */
  _end(item) {
    if (this._d.jobs) this._d.jobs.end(item);
  }

  /** One command: paint it, run it, paint the outcome. `category` is null for later commands of a batch (recomputed). */
  async _runCall(item, call, category, { budgetChars, step, jobKey: key } = {}) {
    const { view, tools, memory, lifecycle, runner } = this._d;
    const kind = category || (tools.isImageTool(bareToolName(call.tool)) ? "screen" : toolCategory(call.tool));
    this._diag("tool.runCat", { name: call.tool, category: kind });

    // Park BEFORE painting the chip or marking the turn dispatched, so a long
    // minimize neither shows a bogus running time nor loses the command on reload.
    if (!(await this._d.park("tool", { name: call.tool }))) return { halted: true };

    // Tell the user WHICH command is running (shown on the composer cover), with its place in a batch.
    if (view.progress) view.progress(runningLabel(call, step));
    view.toolRunning(item, call, kind, { arg: argSummary(call), body: callBody(call) });
    memory.executed(item);
    this._diag("tool.start", { name: call.tool });
    const feedback = await runner.run(call, { budgetChars, jobKey: key });
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
}
