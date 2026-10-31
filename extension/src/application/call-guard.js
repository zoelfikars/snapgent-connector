// SPDX-License-Identifier: GPL-3.0-or-later
// Runs one bridge call under two guards so the agent loop can never hang:
//  - a watchdog that gives a definitive answer even if the worker never replies;
//  - a stop watcher that abandons the wait soon after the user presses Stop.
// The in-flight call may still finish in the background; its result is ignored.

const STOP_POLL_MS = 150;
const WATCHDOG_GRACE_MS = 30000;

/**
 * @param {() => Promise<object>} call
 * @param {{ timeoutMs: number, isStopped: () => boolean, timers: import("./ports.js").Timers }} options
 * @returns {Promise<object>} the call's result, or `{ ok:false, kind:"timeout"|"stopped" }`.
 */
export async function callWithGuards(call, { timeoutMs, isStopped, timers }) {
  let watchdog;
  let poller;
  const timedOut = new Promise((resolve) => {
    watchdog = timers.setTimeout(
      () => resolve({ ok: false, kind: "timeout", error: "no response from the extension worker" }),
      timeoutMs + WATCHDOG_GRACE_MS,
    );
  });
  const stopped = new Promise((resolve) => {
    poller = timers.setInterval(() => { if (isStopped()) resolve({ ok: false, kind: "stopped" }); }, STOP_POLL_MS);
  });
  try {
    return await Promise.race([call(), timedOut, stopped]);
  } finally {
    timers.clearTimeout(watchdog);
    timers.clearInterval(poller);
  }
}
