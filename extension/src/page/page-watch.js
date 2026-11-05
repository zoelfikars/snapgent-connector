// SPDX-License-Identifier: GPL-3.0-or-later
// Keeping the page state current. Whenever the site changes (a mutation, the tab coming back, a profile being stored, and every
// few seconds regardless) the session flags are reconciled with the conversation on screen and the bar is redrawn.

const EVERY_MS = 2500;
const HIDDEN_DELAY_MS = 100;
const MIN_GAP_MS = 250; // a streaming reply changes the page every frame; the bar does not need to follow it that closely

/** @param {{ document: Document, window: Window, provider: object, session: object, bar: object }} deps */
export function startPageWatch({ document, window, provider, session, bar }) {
  let scheduled = false;
  let lastRefreshAt = 0;
  function refresh() {
    scheduled = false;
    lastRefreshAt = Date.now();
    session.sync();
    provider.enforceComposer(); // keep the composer in the modes the profile needs
    bar.render();
  }
  // requestAnimationFrame is PAUSED in a background tab, so a timer stands in (throttled, but it runs).
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(0, lastRefreshAt + MIN_GAP_MS - Date.now());
    if (document.hidden) setTimeout(refresh, Math.max(HIDDEN_DELAY_MS, wait));
    else if (wait) setTimeout(() => window.requestAnimationFrame(refresh), wait);
    else window.requestAnimationFrame(refresh);
  }

  new window.MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(schedule, EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  document.addEventListener("zs-provider-changed", schedule);
  session.sync();
}
