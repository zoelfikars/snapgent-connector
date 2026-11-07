// SPDX-License-Identifier: GPL-3.0-or-later
// The Play button: read the latest reply again and run what has not run yet, then carry on with the loop. A batch that Stop ended
// part-way is carried on from where it stopped (the finished commands are not run again). It is also the retry when the extension
// failed to pick a reply up. A reply that was fully answered is never run a second time.

import { planReplay } from "../domain/agent/agent-mode.js";
import { isInjectedFeedback } from "../domain/parser/index.js";

const MESSAGES = {
  generating: "The AI is still writing · wait for it to finish",
  none: "No command in the last reply",
  "already-ran": "Already ran · nothing new to run",
};

/** @param {{ state: object, provider: object, executed: object, progress?: object, loop: object, bar: object, diag: Function }} deps */
export function createReplay({ state, provider, executed, progress = null, loop, bar, diag }) {
  /** Is our result turn already below this reply? Then its commands were answered. */
  function answered(item) {
    const all = provider.allItems();
    const after = all[all.indexOf(item) + 1];
    return !!(after && provider.isUserItem(after) && isInjectedFeedback(provider.itemText(after)));
  }

  function play() {
    if (!state.started || state.discuss || state.running || state.starting || state.injecting || state.stopping) return;
    const item = provider.lastAssistant();
    if (!item) { bar.toast(MESSAGES.none); return; }
    const text = provider.itemText(item);
    const done = answered(item);
    if (done && progress) progress.clear(item); // what it kept is from a batch that was answered after all
    const pending = progress && !done ? progress.count(item) : 0;
    const plan = planReplay({ text, generating: provider.isGenerating(), alreadyRan: done || executed.has(item, text), pending });
    diag("replay", { type: plan.type, done: plan.done });
    if (plan.type === "resume") bar.toast(`Continuing · ${plan.done} command${plan.done === 1 ? "" : "s"} already done`);
    else if (plan.type !== "run") { bar.toast(MESSAGES[plan.type]); return; }
    state.userStopped = false; // Play is fresh intent
    // The markers the watchdog and the resume net left on this turn must not hold it back now.
    delete item.dataset.zResume; delete item.dataset.zResumeLen; delete item.dataset.zloop;
    state.sendToken = null; // the reply is already there: any current id counts as new
    loop.run(provider.assistantCount() - 1);
  }

  return { play };
}
