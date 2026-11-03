// SPDX-License-Identifier: GPL-3.0-or-later
// Tracks whether the assistant's reply is still growing. Most chat sites expose
// no reliable "generating" flag, so the engine samples the reply length and treat
// "grew recently" as "still generating".

const REGRESSION_TOLERANCE = 400; // a shrink larger than this means a different reply/regeneration

export class StreamSampler {
  /**
   * @param {{ now?: () => number, minLen?: number }} [options]
   *   minLen: shortest reply that counts as real output (guards against placeholder text).
   */
  constructor({ now = Date.now, minLen = 2 } = {}) {
    this._now = now;
    this._minLen = minLen;
    this.reset();
  }

  reset() {
    this.item = null;
    this.max = -1; // longest length seen for the current item
    this.at = 0; // when `max` last increased
  }

  /** Record the current reply (`item`) and its text length. */
  sample(item, length) {
    const now = this._now();
    if (item !== this.item || length < this.max - REGRESSION_TOLERANCE) {
      this.item = item;
      this.max = length;
      this.at = now;
      return;
    }
    if (length > this.max) {
      this.max = length;
      this.at = now;
    }
  }

  /** True if the reply has grown within the last `ms` milliseconds. */
  grewWithin(ms) {
    return this.max >= this._minLen && this._now() - this.at < ms;
  }
}
