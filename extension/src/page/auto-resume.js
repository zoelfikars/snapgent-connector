// SPDX-License-Identifier: GPL-3.0-or-later
// The safety net that keeps the agent going when the loop ended before a command finished (a huge edit, a tab coming back from the
// background, a reload): a COMPLETE command in the latest reply that never produced a result is run. It must NEVER fire on a command
// merely PRESENT on the page, so every guard below says why it did not (`resume.skip`, logged when the reason changes).

import { hasToolSignature, isInjectedFeedback, parseToolCalls } from "../domain/parser/index.js";

const FRESH_MS = 180000; // a long generation can outlast the loop; the command must still run once it ends
const TICK_MS = 1000;

/** @param {{ document: Document, state: object, provider: object, executed: object, loop: object, diag: Function }} deps */
export function createAutoResume({ document, state, provider, executed, loop, diag }) {
  let lastSkip = "";
  const skip = (reason) => { if (reason !== lastSkip) { lastSkip = reason; diag("resume.skip", { reason }); } };

  setInterval(() => {
    if (!state.started || state.running || state.starting || state.injecting) return skip(`state started=${state.started} running=${state.running} starting=${state.starting} injecting=${state.injecting}`);
    if (document.hidden) return skip("hidden");
    if (state.userStopped) return skip("userStopped");
    if (provider.isGenerating()) return skip("generating");
    if (Date.now() - state.lastGenAt > FRESH_MS) return skip("stale");
    const item = provider.lastAssistant();
    if (!item || item.dataset.zloop) return skip(item ? "zloop" : "noItem");
    if (state.bootBaselineId && provider.lastAssistantId && provider.lastAssistantId() === state.bootBaselineId) return skip("bootBaseline");
    if (provider.turnHalted(item)) return skip("halted");
    // A scrolled-back OLD turn (virtualised list) has an id below the newest one seen.
    const id = provider.itemKey ? Number(provider.itemKey(item)) : NaN;
    if (Number.isFinite(id) && state.maxTurnId != null && id < state.maxTurnId) return skip("oldTurn");
    // Every command that ran is followed by our result turn: that separates the pending command from settled history.
    const all = provider.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && provider.isUserItem(after) && isInjectedFeedback(provider.itemText(after))) return skip("resultBelow");
    const text = provider.itemText(item);
    if (!hasToolSignature(text)) return skip("noSignature");
    if (executed.has(item, text)) return skip("alreadyExecuted");
    if (!parseToolCalls(text).length) return skip("unparseable");
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= text.length) return skip("resumedOnce");
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(text.length);
    executed.remember(item);
    diag("autoResume", { len: text.length });
    state.sendToken = null; // the reply is already there: any current id counts as new
    loop.run(provider.assistantCount() - 1);
  }, TICK_MS);
}
