// SPDX-License-Identifier: GPL-3.0-or-later
// Stopping the agent, and watching the site while it runs: the "Stopping…" wind-down, a stop click the site swallowed, and a
// regenerate click after a stop (which is fresh intent: the agent may act on the new reply).

const TICK_MS = 200;
const RETRY_GROWTH_CHARS = 24; // the stream must have grown this much since the stop click for the stop to count as swallowed
const RETRY_GAP_MS = 800;
const QUIET_AFTER_MS = 2500;
const REGENERATE_WINDOW_MS = 2500;
const CLICK_AFTER_STOP_MS = 400;

/** @param {{ document: Document, state: object, provider: object, bar: object, diag: Function }} deps */
export function createStop({ document, state, provider, bar, diag }) {
  function stopLoop() {
    if (state.stopping) return; // already winding down: ignore double clicks
    diag("stopLoop");
    state.stop = true;
    state.stopping = true;
    state.stopAt = Date.now();
    state.stopStreamLen = provider.streamLen();
    state.userStopped = true; // the resume watchdog stays off until the next message
    bar.markStopping();
    provider.stopGeneration();
    bar.toast("Stopping…");
  }

  // The last REAL click on the site (trusted, outside our own UI). A genuine "regenerate" is always one; the site's phantom
  // generations after a stop never are, and that tells them apart.
  let lastUserClickAt = 0;
  document.addEventListener("click", (event) => {
    if (event.isTrusted && !(event.target && event.target.closest && event.target.closest("#zs-root"))) lastUserClickAt = Date.now();
  }, true);

  let previousHardGen = null;

  /** A brand-new generation while stopped and idle can only come from a regenerate click: clear the stop latch. */
  function watchRegenerate(hardGen) {
    const idleAfterStop = state.started && state.userStopped && !state.running && !state.injecting && !state.stopping;
    // Only the site's own stop control counts as "generating": the growth-tolerant signal blips when the site re-renders the halted turn.
    if (!(idleAfterStop && hardGen && previousHardGen === false)) return;
    const clickAge = Date.now() - lastUserClickAt;
    const clickAfterStop = lastUserClickAt - state.stopAt;
    if (clickAge < REGENERATE_WINDOW_MS && clickAfterStop > CLICK_AFTER_STOP_MS) {
      state.userStopped = false;
      const item = provider.lastAssistant();
      if (item) { delete item.dataset.zResume; delete item.dataset.zResumeLen; delete item.dataset.zloop; }
      diag("regenResume", { clickAge, clickAfterStop });
    } else {
      diag("regenEdge.ignored", { clickAge, clickAfterStop });
    }
  }

  /** "Stopping…" must end: re-click the site's stop if it swallowed ours, release it once the site is quiet. */
  function settleStopping() {
    if (!state.stopping || state.running || state.toolRunning) return;
    if (!(state.started && provider.isHardGenerating())) {
      state.stopping = false;
      diag("stop.quiet");
      return;
    }
    // Retry only if the reply kept GROWING since the last stop click: some sites leave the stop button visible for seconds after a
    // successful stop, and a stray second click there kills the NEXT reply.
    const grown = provider.streamLen() > state.stopStreamLen + RETRY_GROWTH_CHARS;
    if (grown && Date.now() - state.stopRetryAt > RETRY_GAP_MS) {
      state.stopRetryAt = Date.now();
      state.stopStreamLen = provider.streamLen();
      try { provider.stopGeneration(); } catch { /* the button is gone */ }
      diag("stop.retry");
    } else if (!grown && Date.now() - state.stopAt > QUIET_AFTER_MS) {
      state.stopping = false;
      diag("stop.quiet", { wedged: true });
    }
  }

  setInterval(() => {
    // The growth-tolerant signal also feeds the resume watchdog's freshness clock: a short command after a long reasoning phase
    // shows the stop square for only a frame or two.
    if (provider.isGenerating()) state.lastGenAt = Date.now();
    // The newest turn id seen (monotonic on sites that number turns): a scrolled-back OLD turn then reads below it and is ignored.
    if (provider.itemKey && provider.lastAssistantId) {
      const id = Number(provider.lastAssistantId());
      if (Number.isFinite(id) && (state.maxTurnId == null || id > state.maxTurnId)) state.maxTurnId = id;
    }
    const hardGen = state.started && provider.isHardGenerating();
    watchRegenerate(hardGen);
    previousHardGen = hardGen;
    settleStopping();
    // Stop stays visible for the whole active turn. The bare site signal is gated on a live session: in a plain chat the user's own
    // message makes the site generate, and our button must not flash over that.
    bar.showStop(state.running || state.toolRunning || state.stopping || (state.started && provider.isHardGenerating()));
  }, TICK_MS);

  return { stopLoop };
}
