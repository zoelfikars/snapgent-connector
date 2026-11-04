// SPDX-License-Identifier: GPL-3.0-or-later
// The messages still to be sent after one that did not hold everything (see domain/prompt/parts). The loop sends the next one
// when the model has answered the one before, and forgets the rest when it ends (a stop, an error, a new chat).

export class PartQueue {
  constructor() {
    this.clear();
  }

  /** @param {string[]} messages  all the messages of one answer; the first is sent by the caller, the rest are kept */
  hold(messages) {
    this._rest = messages.slice(1);
    this._total = messages.length;
  }

  pending() {
    return this._rest.length > 0;
  }

  /** The next message to send, and "part 2 of 3" for the progress label. */
  next() {
    const text = this._rest.shift();
    return { text, label: `part ${this._total - this._rest.length} of ${this._total}` };
  }

  clear() {
    this._rest = [];
    this._total = 0;
  }
}
