// SPDX-License-Identifier: GPL-3.0-or-later
// Messages to the extension's background worker, which holds the socket to the local bridge.
//
// An ORPHANED page (the extension was reloaded or updated while the tab stayed open) fails every call at once with
// "Extension context invalidated". That is told apart from a bridge outage: a bridge outage is fixed by starting the bridge and
// heals itself, this one only by reloading the page and never recovers, so the model and the user must hear different things.

const STALE = /Extension context invalidated|Receiving end does not exist|message port closed/i;

/** @returns {(message: object) => Promise<object>} resolves to the worker's answer, or `{ ok: false, kind, error }` */
export function createExtensionBridge() {
  return (message) => new Promise((resolve) => {
    const fail = (error) => resolve({ ok: false, kind: STALE.test(error || "") ? "stale-extension" : "disconnected", error });
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
        else resolve(reply || { ok: false, kind: "disconnected", error: "no response from background" });
      });
    } catch (error) {
      fail(String((error && error.message) || error));
    }
  });
}
