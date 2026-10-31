// SPDX-License-Identifier: GPL-3.0-or-later
// Decides when to re-state the system prompt and attaches it to an outgoing tool
// result. The result is never truncated to make room: the rider is dropped and the
// flag stays raised, so it rides the next (smaller) result instead.

import { RESEND_RESULTS_EVERY, buildResendRider, fitsBudget, isResendDue } from "../domain/prompt/resend.js";

export class PromptResender {
  /**
   * @param {{ tally: import("./sys-tally.js").SysTally, everyUsers: number, everyResults?: number,
   *           systemPrompt: () => string, domCounts: () => {users:number, results:number},
   *           charBudget?: () => number, now?: () => number, onResent?: (at: number) => void,
   *           diag?: (event: string, data?: object) => void }} deps
   */
  constructor({ tally, everyUsers, everyResults, systemPrompt, domCounts, charBudget = () => Infinity, now = Date.now, onResent = () => {}, diag = () => {} }) {
    Object.assign(this, { _tally: tally, _everyUsers: everyUsers, _everyResults: everyResults, _systemPrompt: systemPrompt, _domCounts: domCounts, _charBudget: charBudget, _now: now, _onResent: onResent, _diag: diag });
  }

  /** Count a typed turn or an injected result toward the budget. */
  bump(field) { this._tally.bump(field); }

  _since() { return this._tally.floorWith(this._domCounts()); }

  due() {
    if (!this._everyUsers) return false;
    const counts = this._since();
    const due = isResendDue(counts, { everyUsers: this._everyUsers, everyResults: this._everyResults });
    // Logged sparsely: this is consulted on EVERY tool result and would flush the diag ring.
    if (due || counts.results % 4 === 0) {
      const mem = this._tally.counts();
      this._diag("sys.tally", {
        ...counts, due, mem: `${mem.users}/${mem.results}`,
        need: `${this._everyUsers}u ${this._everyResults ?? RESEND_RESULTS_EVERY}r`,
      });
    }
    return due;
  }

  /** Record that a re-statement is being sent now (resets the budget); returns what was spent. */
  claim(via, data = {}) {
    const spent = this._since();
    this._tally.reset();
    this._onResent(this._now());
    this._diag("sys.resend", { via, ...data, ...spent });
    return spent;
  }

  /** Attach the prompt to `text` if one is due and it fits. */
  attach(text) {
    if (!this.due()) return text;
    const rider = buildResendRider(this._systemPrompt());
    if (!fitsBudget(text.length, rider.length, this._charBudget())) {
      this._diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap: this._charBudget() });
      return text;
    }
    this.claim("toolResult", { chars: rider.length });
    return text + rider;
  }
}
