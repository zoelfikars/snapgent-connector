// SPDX-License-Identifier: GPL-3.0-or-later
// Polling helper shared by every chat adapter.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves true as soon as `predicate()` is truthy, false once `timeoutMs` elapses.
 * Clock and sleep are injectable so callers can be tested without real time.
 */
export async function waitFor(predicate, timeoutMs, { intervalMs = 120, now = Date.now, sleep = defaultSleep } = {}) {
  const start = now();
  while (now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}
