// SPDX-License-Identifier: GPL-3.0-or-later
// Sends one message into the chat and reports where the reply will start.
// Returns the assistant-turn count BEFORE the send: ResponseWatcher waits past it.
//
// Sending is the fragile part of this extension (every site's composer differs), so
// the policy is explicit: settle first, never type while the tab is hidden, retry a
// bounded number of times, treat "composer cleared" or "a new turn appeared" as
// landed, and say so out loud when nothing landed.

const DEFAULT_RETRY_LIMIT = 4;
const SETTLE_SAMPLE_MS = 100;
const STILL_GENERATING_WAIT_MS = 4000;
const LANDED_WAIT_MS = 3500;

export const resolveRetryLimit = (raw) => (Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RETRY_LIMIT);

export class MessageSender {
  /**
   * @param {{
   *   page: import("./ports.js").ComposerPort,
   *   visibility: import("./ports.js").VisibilityPort,
   *   effects: import("./ports.js").SendEffectsPort,
   *   clock: { sleep: (ms: number) => Promise<void>, waitFor: (predicate: () => boolean, timeoutMs: number) => Promise<boolean> },
   *   isStopped: () => boolean,
   *   retryLimit?: number,
   *   notify: { banner: (level: string, title: string, text: string) => void },
   *   diag?: (event: string, data?: object) => void,
   * }} deps
   */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag || (() => {});
    this._maxTries = resolveRetryLimit(deps.retryLimit);
  }

  /** @returns {Promise<number>} the assistant-turn count before the reply */
  async submit(text) {
    const { page, effects } = this._d;
    effects.begin();
    this._diag("send", { text: String(text).slice(0, 60), busy: page.isBusyNow() });
    try {
      await this._settlePreviousReply();
      const base = page.assistantCount();
      const preUser = page.userCount();
      const landed = () => page.userCount() > preUser || page.assistantCount() > base;
      const { sent, tries } = await this._sendWithRetries(text, landed);
      if (sent) this._diag("send.cleared", { tries });
      // Returning silently here leaves the loop waiting ~60s for a reply that will never come.
      if (!sent && !landed() && !this._d.isStopped()) {
        this._diag("send.failed", { tries });
        this._d.notify.banner("warn", "Message could not be sent", 'Send "continue" to resume.');
      }
      return base;
    } finally {
      effects.end();
    }
  }

  /**
   * Quick 2-point settle: sample the previous reply's length before and after a short yield. A one-shot
   * React flush shows no second growth and costs only that yield; a genuinely streaming reply shows
   * growth, so wait for the full idle.
   */
  async _settlePreviousReply() {
    const { page, clock } = this._d;
    const item = page.lastAssistant();
    const before = item ? page.streamLen(item) : 0;
    await clock.sleep(SETTLE_SAMPLE_MS);
    if (item && item === page.lastAssistant() && page.streamLen(item) > before) {
      await clock.waitFor(() => !page.isGenerating(), STILL_GENERATING_WAIT_MS);
    }
  }

  async _sendWithRetries(text, landed) {
    const { page, visibility, effects, clock, isStopped } = this._d;
    let tries = 0;
    let sent = false;
    while (!sent && !landed() && tries < this._maxTries && !isStopped()) {
      // Never type/send while hidden: throttled rendering made the landed check unreliable and
      // caused the SAME feedback to be sent several times.
      if (visibility.isHidden()) {
        this._diag("send.waitVisible", { tries });
        if (!(await visibility.waitUntilVisible()) || isStopped()) break;
      }
      this._diag("submit.typeAndSend");
      await page.typeAndSend(text);
      // The site clears the composer as soon as the send is accepted: faster and more reliable than a turn count.
      await clock.waitFor(() => {
        if (page.editorText().trim() === "") sent = true;
        return sent || landed();
      }, LANDED_WAIT_MS);
      tries++;
    }
    return { sent, tries };
  }
}
