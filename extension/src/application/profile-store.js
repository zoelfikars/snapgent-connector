// SPDX-License-Identifier: GPL-3.0-or-later
// Where site profiles live: one JSON object in extension storage, keyed by host name, plus export and import as a file.
// A profile is data about a page layout, never about a conversation.

const KEY = "zsProfiles";

/** The validity check is injected so this layer does not depend on how profiles are described. */
export class ProfileStore {
  /**
   * @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: *) => Promise<void>|void },
   *           problemsOf: (profile: *) => string[] }} deps
   */
  constructor({ store, problemsOf }) {
    this._store = store;
    this._problemsOf = problemsOf;
  }

  async _all() {
    const all = await this._store.get(KEY);
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  }

  async get(host) { return (await this._all())[host] || null; }

  /** @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
  async save(profile) {
    const problems = this._problemsOf(profile);
    if (problems.length) return { ok: false, error: `Not a usable profile: ${problems.join(", ")}.` };
    await this._store.set(KEY, { ...(await this._all()), [profile.site]: profile });
    return { ok: true };
  }

  async remove(host) {
    const { [host]: _removed, ...rest } = await this._all();
    await this._store.set(KEY, rest);
  }

  /** The profile for `host` as the text of a file, or null when there is none. */
  async exportText(host) {
    const profile = await this.get(host);
    return profile ? JSON.stringify(profile, null, 2) + "\n" : null;
  }

  /** Accept a profile file for THIS host only: a profile for another site would silently do nothing here. */
  async importText(text, host) {
    let profile;
    try { profile = JSON.parse(text); } catch { return { ok: false, error: "That file is not valid JSON." }; }
    if (!profile || typeof profile !== "object") return { ok: false, error: "That file is not a profile." };
    if (profile.site !== host) return { ok: false, error: `That profile is for ${profile.site || "another site"}, not ${host}.` };
    return this.save(profile);
  }
}
