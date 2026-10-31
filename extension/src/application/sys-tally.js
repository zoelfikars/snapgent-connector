// SPDX-License-Identifier: GPL-3.0-or-later
// How much conversation has accumulated since the operating instructions were last
// stated, PERSISTED per conversation. An in-memory counter resets on every reload
// while the session survives one; walking the DOM under-counts because sites
// virtualise their lists. Counting at injection time and persisting is exact.
// Increments are synchronous (storage is durability, not the source of truth for
// this tick), otherwise the tally lags a turn behind exactly when it matters.

export class SysTally {
  /**
   * @param {{ storage: { get: (key: string) => Promise<*>, set: (key: string, value: object) => void },
   *           conversationKey: () => string, enabled: boolean }} deps
   */
  constructor({ storage, conversationKey, enabled }) {
    this._storage = storage;
    this._conversationKey = conversationKey;
    this._enabled = enabled;
    this._counts = { users: 0, results: 0 };
    this._hydratedKey = ""; // conversation whose stored tally has been merged in ("" = never)
  }

  _key() { return `zsSys:${this._conversationKey() || "new"}`; }

  counts() { return { ...this._counts }; }

  /**
   * Hydrate from storage (startup or a conversation switch). Counts accumulated in memory BEFORE the
   * first hydrate are kept (a bump must never be lost to a slow read); counts belonging to a
   * DIFFERENT conversation are discarded.
   */
  async hydrate() {
    const key = this._key();
    if (key === this._hydratedKey) return this.counts();
    const carried = this._hydratedKey === "" ? this._counts : { users: 0, results: 0 };
    this._hydratedKey = key; // set before awaiting so a concurrent hydrate does not repeat the read
    this._counts = { users: 0, results: 0 };
    try {
      const saved = await this._storage.get(key);
      this._counts = {
        users: Math.max((saved && saved.users) || 0, carried.users || 0),
        results: Math.max((saved && saved.results) || 0, carried.results || 0),
      };
    } catch {
      this._counts = { ...carried }; // storage unavailable: keep what we have
    }
    if (carried.users || carried.results) this._persist(); // write the merged tally back
    return this.counts();
  }

  /** @param {"users"|"results"} field */
  bump(field) {
    if (!this._enabled) return;
    this._followConversation();
    this._counts[field]++;
    this._persist();
  }

  reset() {
    this._followConversation();
    this._counts = { users: 0, results: 0 };
    this._persist();
  }

  /** The larger of the stored tally and what is visibly on screen. */
  floorWith(dom) {
    return { users: Math.max(this._counts.users, dom.users), results: Math.max(this._counts.results, dom.results) };
  }

  /** Switched conversation since the last hydrate: the old counts are not ours any more. */
  _followConversation() {
    if (this._hydratedKey && this._hydratedKey !== this._key()) {
      this._counts = { users: 0, results: 0 };
      this._hydratedKey = ""; // the next hydrate merges this conversation's stored tally
    }
  }

  _persist() {
    // Until the stored tally has been merged in, writing would overwrite it with a partial count.
    if (!this._hydratedKey) return;
    try { this._storage.set(this._key(), this._counts); } catch { /* best effort */ }
  }
}
