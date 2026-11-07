// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the commands of ONE reply and answers with ONE message (see AgentLoop, which decides when to).
//
// The message has a size limit: each command gets an even share of what is left, tools that can limit their own
// output do, and a command that would only get a sliver is not run. What does not fit in one message goes in the next
// ones (PartQueue; the model is told to acknowledge briefly meanwhile). Nothing after a failure, an image or a stop runs. Every command carries a job key (batch id + place + content), so when the page is reloaded mid-batch and the
// reply is run again, commands that already ran are answered from the server's record instead of running twice.

import { feedbackIsError, runningLabel } from "../domain/tools/result-summary.js";
import { jobKey } from "../domain/tools/job-key.js";
import { DEFAULT_BATCH_CALLS, MAX_RESULT_PARTS, MIN_CALL_CHARS, callShare, composeBatch, sessionIsLarge, trimMiddle } from "../domain/prompt/budget.js";
import { partMessages } from "../domain/prompt/parts.js";
import { FEEDBACK } from "../domain/prompt/feedback.js";

const RERUN_NOTE = "(This command was interrupted by Stop earlier and has been run again.)";

export class BatchRunner {
  /** @param {object} deps  the AgentLoop's deps, plus `park(scope, extra)` (wait while the tab is hidden) and `diag` */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag;
    this._budget = deps.budget;
    this.lastSentChars = 0;
  }

  /** Room in the next message for what is added AFTER the results: the command reminder and a re-stated system prompt. */
  _reserved(calls = []) {
    const { reminder, tools, outbox } = this._d;
    let reserved = calls.some((call) => call.native) ? FEEDBACK.nativeFormat.length : 0;
    if (typeof reminder.willBeDue === "function" && reminder.willBeDue({ hasCatalogue: tools.hasCatalogue() })) reserved += tools.reminderText().length;
    if (typeof outbox.reserve === "function") reserved += outbox.reserve();
    return reserved;
  }

  /**
   * Run every command of one reply in order and answer with ONE message. The message has a size limit: each command
   * gets an even share of what is left, and tools that can limit their own output read or keep only what fits. A
   * command that would only get a sliver is not run; neither is anything after a failure, an image, or a stop.
   */
  async run(item, calls) {
    const { tools, reminder } = this._d;
    const maxCalls = this._budget.calls ? this._budget.calls() : DEFAULT_BATCH_CALLS;
    const batch = calls.slice(0, maxCalls);
    const notRun = calls.slice(maxCalls).map((call) => ({ tool: call.tool, why: `at most ${maxCalls} commands per reply` }));
    const results = [];
    const messageRoom = Math.max(MIN_CALL_CHARS, this._budget.limit() - this._reserved(batch));
    // All the messages together may hold this much; the output of one command may run over from one message into the next.
    const room = this._d.parts ? messageRoom * MAX_RESULT_PARTS : messageRoom;
    const batchId = this._d.jobs ? await this._d.jobs.begin(item) : null;
    const progress = this._d.progress;
    // Commands that finished before a Stop: their answers are reused and they are not run again (see BatchProgress).
    const prior = progress ? progress.resume(item, batch) : [];
    let used = 0;
    let failed = false;
    let last = batch[0];

    for (let index = 0; index < batch.length; index++) {
      const call = batch[index];
      const remaining = room - used;
      const reused = index < prior.length;
      // `from` is the first command that did NOT run: this one when it was skipped, the next one when it ran and failed.
      const skipRest = (why, from = index) => notRun.unshift(...batch.slice(from).map((c) => ({ tool: c.tool, why })));
      if (!reused && index > 0 && remaining < MIN_CALL_CHARS) { skipRest("the message size limit was reached"); break; }

      const step = reused ? prior[index] : await this._runCall(item, call, {
        jobKey: batchId && jobKey(batchId, index, call), budgetChars: callShare(remaining, batch.length - index), step: { index, total: batch.length },
      });
      if (step.halted) {
        if (progress) progress.interrupt(item, index); // the next run says so for this command
        // Stopped before ANY command gave a result: forget that this reply "ran", so Play may run it again. Once a command has
        // finished the record stays, because running the whole reply again could run that command twice.
        if (!results.length && this._d.memory.forget) this._d.memory.forget(item);
        this._end(item);
        return { halted: true };
      }
      last = call;
      const rerun = !reused && !!progress && progress.wasInterrupted(item, index);
      const answer = rerun ? `${step.feedback}\n${RERUN_NOTE}` : step.feedback;
      const text = answer.length > remaining ? trimMiddle(answer, remaining, "the results") : answer;
      results.push(text);
      if (!reused && progress) progress.record(item, index, call, text, step.isErr);
      used += text.length + 2;
      failed = failed || step.isErr;
      this._diag("batch.step", { name: call.tool, index, of: batch.length, chars: text.length, left: room - used });

      if (step.isErr && index < batch.length - 1) { skipRest("stopped after the error above", index + 1); break; }
    }

    const ran = results.length;
    const said = ran === calls.length ? (ran === 1 ? "Command done" : `${ran}/${ran} commands done`) : `${ran} of ${calls.length} commands run`;
    const composed = composeBatch(results, notRun);
    // "Output as file": one message, however long; the chat turns it into a file when it is over the size (page/output-file.js).
    const asFile = typeof this._budget.asFile === "function" && this._budget.asFile();
    const messages = asFile ? [composed] : this._d.parts ? partMessages(composed, messageRoom, MAX_RESULT_PARTS) : [composed.length > room ? trimMiddle(composed, room, "the results") : composed];
    // Calls the model wrote in its own markup were run anyway; it is told, in the same message, to use our commands next time.
    if (batch.some((call) => call.native)) {
      messages[messages.length - 1] += FEEDBACK.nativeFormat;
      this._diag("tools.nativeNote", { format: batch.find((call) => call.native).native });
    }
    if (reminder.onResult({ isErr: failed, tool: last.tool, hasCatalogue: tools.hasCatalogue() })) {
      messages[messages.length - 1] += tools.reminderText();
      this._diag("tools.reminder");
    }
    // The result becomes a turn: it counts toward the system-prompt re-statement budget and may carry it.
    messages[0] = this._d.outbox.prepare(messages[0]);
    if (messages.length > 1) { this._d.parts.hold(messages); this._diag("batch.parts", { parts: messages.length, chars: composed.length }); }
    this.lastSentChars = messages[0].length;
    if (this._budget.sent && sessionIsLarge(this._budget.sent(composed.length), this._budget.limit())) this._d.view.toast("This chat is getting large. A new chat will be cheaper.");
    if (this._d.view.progress) this._d.view.progress(`${said} · sending the results to the AI…`);
    const base = await this._d.chat.submit(messages[0]);
    if (progress) progress.clear(item); // answered: a later run of this reply starts over
    this._end(item);
    return { base };
  }

  /** The batch is over (answered, or stopped): the next run of this reply is a new batch, not a resumption. */
  _end(item) {
    if (this._d.jobs) this._d.jobs.end(item);
  }

  /** One command: announce it, run it, say how it went. */
  async _runCall(item, call, { budgetChars, step, jobKey: key }) {
    const { view, memory, lifecycle, runner } = this._d;
    // Park BEFORE marking the turn dispatched, so a long minimize neither shows a bogus running time nor loses the command on reload.
    if (!(await this._d.park("tool", { name: call.tool }))) return { halted: true };

    if (view.progress) view.progress(`Running ${step && step.total > 1 ? "command " : ""}${runningLabel(call, step)}`);
    view.toolRunning(item, call);
    memory.executed(item);
    this._diag("tool.start", { name: call.tool });
    const feedback = await runner.run(call, { budgetChars, jobKey: key });
    view.toolFinished();
    if (lifecycle.isStopped()) return { halted: true };

    const isErr = feedbackIsError(feedback);
    this._diag("tool.done", { name: call.tool, isErr, chars: feedback.length, firstLine: feedback.split("\n", 2).join(" | ").slice(0, 90) });
    return { feedback, isErr };
  }
}
