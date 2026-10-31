// SPDX-License-Identifier: GPL-3.0-or-later
// Detects a loop that is stuck waiting. If nothing observable changes for
// `stallMs` while the agent is NOT legitimately paused (hidden tab, running tool,
// injecting a message), it reports a stall so the loop can release the UI
// instead of leaving a dead bar.

export class StallWatchdog {
  /**
   * @param {{ signature: () => string, isPaused: () => boolean, onStall: (signature: string) => void,
   *           timers: import("./ports.js").Timers, now?: () => number, stallMs?: number, pollMs?: number }} deps
   */
  constructor({ signature, isPaused, onStall, timers, now = Date.now, stallMs = 180000, pollMs = 5000 }) {
    this._signature = signature;
    this._isPaused = isPaused;
    this._onStall = onStall;
    this._timers = timers;
    this._now = now;
    this._stallMs = stallMs;
    this._pollMs = pollMs;
    this._timer = null;
  }

  start() {
    this.stop();
    let lastSignature = "";
    let changedAt = this._now();
    this._timer = this._timers.setInterval(() => {
      if (this._isPaused()) { changedAt = this._now(); return; }
      const signature = this._signature();
      if (signature !== lastSignature) { lastSignature = signature; changedAt = this._now(); return; }
      if (this._now() - changedAt > this._stallMs) {
        this._onStall(signature);
        changedAt = this._now(); // do not fire again until another full window passes
      }
    }, this._pollMs);
  }

  stop() {
    if (this._timer !== null) this._timers.clearInterval(this._timer);
    this._timer = null;
  }
}
