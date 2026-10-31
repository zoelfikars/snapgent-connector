// SPDX-License-Identifier: GPL-3.0-or-later
// The mutable timers and observations of ONE wait for a reply. Keeping them in a
// single object (instead of a dozen locals) makes the gates in ResponseWatcher
// small, and lets "the tab was hidden for N ms" slide every deadline in one call.

export class WatchState {
  constructor(now) {
    this.now = now;
    const t = now();
    this.startedAt = t;
    this.lastActiveAt = t;   // last time the model generated or the text grew (inactivity timeout anchor)
    this.lastChangeAt = t;   // last time the normalised reply text changed
    this.started = false;    // has the reply for THIS send begun?
    this.doneSince = 0;      // when every "still working" gate first cleared
    this.lastLimitScan = 0;
    this.lastText = null;
    this.genFalseSince = 0;  // how long the generating flag has been off (resets on a flicker back on)
    this.preStartSilent = 0; // nothing produced and not generating
    this.warmSince = 0;      // current turn has produced nothing yet
    this.reasonSince = 0;    // reasoning written but no answer yet
    this.noTurnSince = 0;    // tried to finalize before this send's reply turn exists
    this.unsettledSince = 0; // command-shaped reply whose read is not yet stable
    this.noTurnLoggedAt = 0;
    // Per-turn: reset whenever the turn NODE changes so a new turn never inherits the previous one's text.
    this.curItem = null;
    this.sawContent = false;
    this.lastGoodReply = ""; // last NON-EMPTY read: a re-render can return "" for a frame at the moment we finalize
    // Finalisation-latency instrumentation (diagnostics only).
    this.genOffFirstAt = 0;  // first moment gen went false after streaming began (does not reset on flicker)
    this.genFlickers = 0;    // times gen flipped back on after being off
    this.prevGen = null;
    this.waitedBlock = 0;
    this.waitedFlicker = 0;
  }

  /** The tab was hidden for `ms`: slide every running deadline forward by that much. */
  shift(ms) {
    this.lastActiveAt += ms;
    this.lastChangeAt += ms;
    for (const key of ["doneSince", "genFalseSince", "preStartSilent", "warmSince", "reasonSince", "noTurnSince", "unsettledSince", "genOffFirstAt"]) {
      if (this[key]) this[key] += ms;
    }
  }

  /** Track which turn we are looking at and whether it has produced anything. */
  observeTurn(d) {
    if (d.item !== this.curItem) {
      this.curItem = d.item;
      this.sawContent = false;
      this.warmSince = 0;
      this.lastGoodReply = "";
    }
    if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) this.sawContent = true;
    if (d.reply && d.reply.length) this.lastGoodReply = d.reply;
  }

  /**
   * Track text stability independent of the generating flag. The reply is compared with whitespace
   * collapsed so cosmetic re-renders (syntax highlighting, copy-bar churn) do not count as changes.
   */
  observeStability(d, gen) {
    const t = this.now();
    const normalised = (d.reply || "").replace(/\s+/g, " ").trim();
    if (normalised !== this.lastText) {
      this.lastText = normalised;
      this.lastChangeAt = t;
      this.lastActiveAt = t;
    }
    if (gen) this.genFalseSince = 0;
    else if (!this.genFalseSince) this.genFalseSince = t;
    if (this.started && !gen && !this.genOffFirstAt) this.genOffFirstAt = t;
    if (this.prevGen === false && gen && this.genOffFirstAt) this.genFlickers++;
    this.prevGen = gen;
  }

  /** Payload for the "stopGoneToResp" diagnostic. */
  latency(kind) {
    const t = this.now();
    return {
      kind,
      stopGoneToRespMs: this.genOffFirstAt ? t - this.genOffFirstAt : null,
      genStableForMs: this.genFalseSince ? t - this.genFalseSince : null,
      lastChangeAgoMs: t - this.lastChangeAt,
      genFlickers: this.genFlickers,
      waitedBlock: this.waitedBlock,
      waitedFlicker: this.waitedFlicker,
      totalMs: t - this.startedAt,
    };
  }
}
