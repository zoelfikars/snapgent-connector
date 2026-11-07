// SPDX-License-Identifier: GPL-3.0-or-later
// The Play button: read the latest reply again and, if it holds a command that has not run, run it and carry on with the loop.
// It is also the retry when the extension failed to pick a reply up. A reply that already ran is never run a second time.

import { planReplay } from "../domain/agent/agent-mode.js";
import { isInjectedFeedback } from "../domain/parser/index.js";

const MESSAGES = {
  generating: "The AI is still writing · wait for it to finish",
  none: "No command in the last reply",
  "already-ran": "Already ran · nothing new to run",
};

/** @param {{ state: object, provider: object, executed: object, loop: object, bar: object, diag: Function }} deps */
export function createReplay({ state, provider, executed, loop, bar, diag }) {
  /** Did this reply's command run? We remember it, or our result turn already follows it on the page. */
  function alreadyRan(item, text) {
    if (executed.has(item, text)) return true;
    const all = provider.allItems();
    const after = all[all.indexOf(item) + 1];
    return !!(after && provider.isUserItem(after) && isInjectedFeedback(provider.itemText(after)));
  }

  function play() {
    if (!state.started || state.discuss || state.running || state.starting || state.injecting || state.stopping) return;
    const item = provider.lastAssistant();
    if (!item) { bar.toast(MESSAGES.none); return; }
    const text = provider.itemText(item);
    const plan = planReplay({ text, generating: provider.isGenerating(), alreadyRan: alreadyRan(item, text) });
    diag("replay", { type: plan.type });
    if (plan.type !== "run") { bar.toast(MESSAGES[plan.type]); return; }
    state.userStopped = false; // Play is fresh intent
    // The markers the watchdog and the resume net left on this turn must not hold it back now.
    delete item.dataset.zResume; delete item.dataset.zResumeLen; delete item.dataset.zloop;
    state.sendToken = null; // the reply is already there: any current id counts as new
    loop.run(provider.assistantCount() - 1);
  }

  return { play };
}
