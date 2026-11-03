// SPDX-License-Identifier: GPL-3.0-or-later
// The agent loop, wired to this page: what it announces, how it starts and ends, and where its messages go.

import { AgentLoop, ToolReminder } from "../application/index.js";

/**
 * @param {{ state: object, provider: object, tools: object, chat: object, bar: object, visibility: object, executed: object,
 *           budget: object, jobs: object, resend: object, diag: Function }} deps
 */
export function createLoop({ state, provider, tools, chat, bar, visibility, executed, budget, jobs, resend, diag }) {
  const reminder = new ToolReminder();

  const lifecycle = {
    start() {
      state.running = true;
      state.stop = false;
      state.stopping = false; // never inherit a stale "Stopping…" from a Stop click before the loop started
      state.loopKey = null; // pinned by the session sync once this chat has an id and content
      bar.showStop(true);
      provider.setInputLock(true);
      bar.cover(true);
    },
    end() {
      state.running = false;
      state.stop = false;
      // Keep "Stopping…" while the site's stream is still draining after a user stop.
      const draining = state.stopping && state.started && provider.isHardGenerating();
      if (state.stopping && draining) diag("stop.drain", { keptStopping: true });
      state.stopping = draining;
      state.toolRunning = false;
      state.loopKey = null;
      bar.showStop(false);
      bar.coverLabel("");
      bar.cover(false);
      provider.setInputLock(false);
    },
    isStopped: () => state.stop,
    halt: () => { state.stop = true; },
  };

  const view = {
    banner: bar.banner,
    toast: bar.toast,
    keepCover: () => bar.cover(true),
    progress: bar.coverLabel,
    toolRunning(item) {
      state.toolRunning = true;
      if (item) item.dataset.zloop = "1"; // the loop owns this turn: the resume watchdog leaves it alone
    },
    toolFinished: () => { state.toolRunning = false; },
  };

  const loop = new AgentLoop({
    chat: chat.turns,
    view,
    lifecycle,
    visibility,
    runner: tools.runner,
    tools: { hasCatalogue: () => tools.catalogue.hasAny(), reminderText: tools.reminderText },
    memory: { executed: (item) => executed.remember(item) },
    outbox: {
      // A result is a turn: it counts toward the system-prompt re-statement budget and may carry it.
      prepare: (text) => { resend.bump("results"); return resend.attach(text); },
      reserve: resend.reserve,
    },
    budget,
    jobs,
    reminder,
    // Nothing observable changing while the tab is visible and no tool runs means the loop is stuck.
    activity: {
      signature: () => [provider.assistantCount(), provider.userCount(), provider.streamLen(), provider.isGenerating() ? 1 : 0].join("|"),
      isPaused: () => document.hidden || state.parked || state.toolRunning || state.injecting,
    },
    timers: window,
    displayName: () => provider.displayName,
    diag,
  });

  return {
    reminder,
    /** Start the loop on the reply after `base`, unless it is already running. */
    run(base) {
      if (state.running) return undefined;
      return loop.run(base).catch((error) => diag("loop.crash", { msg: String((error && error.message) || error) }));
    },
  };
}
