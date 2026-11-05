// SPDX-License-Identifier: GPL-3.0-or-later
// Nothing is read, parsed or executed while the tab is in the background (the page cannot be read then): the agent parks until the
// tab is the foreground tab of its window again. There is NO time cap on purpose: a tab minimised for an hour must resume cleanly.
//
// Waiting is event driven. A chained setTimeout poll is clamped to one tick a minute once a tab has been hidden for 5 minutes,
// so a poll could take a minute to notice the tab came back; `visibilitychange` fires at once, and a slow interval only covers a
// Stop pressed while parked.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

/** @param {{ document: Document, state: object, diag: Function, onParkChange: () => void }} deps */
export function createVisibility({ document, state, diag, onParkChange }) {
  /** Resolves false ONLY if the user stopped while parked, so the caller can break out. */
  async function waitVisible() {
    if (!document.hidden || state.stop) return !state.stop;
    state.parked = true;
    onParkChange();
    try {
      await new Promise((resolve) => {
        let poll = 0;
        const check = () => {
          if (!state.stop && document.hidden) return;
          document.removeEventListener("visibilitychange", check);
          clearInterval(poll);
          resolve();
        };
        document.addEventListener("visibilitychange", check);
        poll = setInterval(check, 1000);
      });
    } finally {
      state.parked = false;
      onParkChange();
    }
    return !state.stop;
  }

  /**
   * Park while hidden and report how long, so callers can slide their deadlines forward by that much. Without it every
   * timeout in the response watcher keeps ticking while nothing can be read, and "switched to another app for 5 minutes"
   * becomes "no response from the site".
   */
  async function parkHidden() {
    if (!document.hidden || state.stop) return 0;
    const start = Date.now();
    await waitVisible();
    const parked = Date.now() - start;
    diag("park.resumed", { parkedMs: parked });
    if (!state.stop) await sleep(400); // a tab that was hidden has no layout: the first reads after it can come back blank
    return parked;
  }

  return { isHidden: () => document.hidden, waitUntilVisible: waitVisible, parkHidden };
}
