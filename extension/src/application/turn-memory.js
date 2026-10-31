// SPDX-License-Identifier: GPL-3.0-or-later
// A record of assistant turns kept OUTSIDE the DOM. Sites re-render or virtualize the conversation, which
// destroys a turn's node and every marker stored on it, so "this turn was halted" and "this turn's command
// already ran" must survive node recreation. A turn is identified by conversation + a stable per-turn key +
// the text prefix seen when it was recorded (recorded mid-stream, so later text only ever extends it).

const PREFIX_LENGTH = 60;
// Too little text cannot identify a turn: a still-streaming command would match ANY later turn at the same key.
const MIN_IDENTIFYING_LENGTH = 12;

export class TurnMemory {
  /**
   * @param {{ conversationKey: () => string,
   *           keyOf: (item: Element) => string,         // stable per turn, even on a virtualized list
   *           isRendered: (item: Element) => boolean,   // is it one of the assistant turns currently on the page
   *           textOf: (item: Element) => string }} ports
   */
  constructor({ conversationKey, keyOf, isRendered, textOf }) {
    Object.assign(this, { _conversation: conversationKey, _keyOf: keyOf, _isRendered: isRendered, _textOf: textOf });
    this._seen = new Map(); // "conversation|turnKey" -> text prefix at the time
  }

  _id(item) { return `${this._conversation()}|${this._keyOf(item)}`; }

  remember(item) {
    try {
      if (!item || !this._isRendered(item)) return;
      const prefix = (this._textOf(item) || "").slice(0, PREFIX_LENGTH);
      if (prefix.trim().length < MIN_IDENTIFYING_LENGTH) return; // the caller keeps relying on the DOM marker until there is enough text
      this._seen.set(this._id(item), prefix);
    } catch { /* the page may be mid-navigation; remembering is best effort */ }
  }

  forget(item) {
    if (!item || !this._seen.size) return;
    try { this._seen.delete(this._id(item)); } catch { /* see remember */ }
  }

  /** Was this turn recorded, and is `text` (its current text) a continuation of what was recorded? */
  has(item, text) {
    if (!this._seen.size) return false;
    try {
      const prefix = this._seen.get(this._id(item));
      return prefix != null && (text || "").startsWith(prefix);
    } catch { return false; }
  }
}
