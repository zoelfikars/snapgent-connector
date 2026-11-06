// SPDX-License-Identifier: GPL-3.0-or-later
// Where site profiles live: one JSON object in extension storage, keyed by host name, plus export and import as a file.
// A profile is data about a page layout, never about a conversation.

const KEY = "zsProfiles";
export const BUNDLE_FORMAT = "snapgent-calibrations";

/** The validity check is injected so this layer does not depend on how profiles are described. */
export class ProfileStore {
  /**
   * @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: *) => Promise<void>|void },
   *           problemsOf: (profile: *) => string[],
   *           siteOf?: (host: string) => ({ id: string, name: string }|undefined) }} deps
   *   `siteOf` says which AI (of the "switch AI" list) a host belongs to; it is how a file of many profiles is kept apart per AI.
   */
  constructor({ store, problemsOf, siteOf = () => undefined, preferences = null }) {
    this._store = store;
    this._problemsOf = problemsOf;
    this._siteOf = siteOf;
    this._preferences = preferences;
  }

  async _all() {
    const all = await this._store.get(KEY);
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  }

  _extractPrefs(data) { if (!data || typeof data.preferences !== "object" || !data.preferences || Array.isArray(data.preferences)) return null; const out = {}; if (Array.isArray(data.preferences.excludedFolders)) out.excludedFolders = [...data.preferences.excludedFolders]; if (Array.isArray(data.preferences.contextFiles)) out.contextFiles = [...data.preferences.contextFiles]; return Object.keys(out).length ? out : null; }
  async _currentPrefs() { if (!this._preferences) return null; try { return await this._preferences.readPreferences(); } catch { return null; } }
  async _applyPrefs(prefs) { if (!prefs || !this._preferences) return; try { await this._preferences.applyPreferences(prefs); } catch {} }

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
    if (!profile) return null;
    const prefs = await this._currentPrefs();
    return JSON.stringify(prefs ? { ...profile, preferences: prefs } : profile, null, 2) + "\n";
  }

  /** Accept a profile file for THIS host only: a profile for another site would silently do nothing here. */
  async importText(text, host) {
    let profile;
    try { profile = JSON.parse(text); } catch { return { ok: false, error: "That file is not valid JSON." }; }
    if (!profile || typeof profile !== "object") return { ok: false, error: "That file is not a profile." };
    if (profile.site !== host) return { ok: false, error: `That profile is for ${profile.site || "another site"}, not ${host}.` };
    const prefs = this._extractPrefs(profile);
    if (prefs) delete profile.preferences;
    const result = await this.save(profile);
    if (result.ok) await this._applyPrefs(prefs);
    return result;
  }

  /** Every stored profile in ONE file, kept apart per AI: `sites.<id>.profiles.<host>`. Null when nothing is calibrated. */
  async exportAllText() {
    const all = await this._all();
    const sites = {};
    for (const [host, profile] of Object.entries(all)) {
      const site = this._siteOf(host) || { id: host, name: host };
      sites[site.id] = sites[site.id] || { name: site.name, profiles: {} };
      sites[site.id].profiles[host] = profile;
    }
    const prefs = await this._currentPrefs();
    return Object.keys(sites).length ? JSON.stringify(prefs ? { format: BUNDLE_FORMAT, version: 1, preferences: prefs, sites } : { format: BUNDLE_FORMAT, version: 1, sites }, null, 2) + "\n" : null;
  }

  /**
   * Read calibration files (a file of many profiles, or a single profile as "Export calibration" writes it) and sort what is in them per
   * AI, without storing anything. A profile that is not usable is left out and said so in `skipped`.
   * @param {string[]} texts the contents of the files
   * @returns {Promise<{ groups: { id: string, name: string, profiles: object[], replaces: boolean }[], skipped: string[] }>}
   */
  async read(texts) {
    let filePrefs = null;
    const found = [];
    const skipped = [];
    for (const text of texts) {
      let data;
      try { data = JSON.parse(text); } catch { skipped.push("a file that is not valid JSON"); continue; }
      const ep = this._extractPrefs(data);
      if (ep) filePrefs = ep;
      if (data && data.format === BUNDLE_FORMAT && data.sites && typeof data.sites === "object") {
        for (const site of Object.values(data.sites)) found.push(...Object.values((site && site.profiles) || {}));
      } else if (data && typeof data === "object" && data.site) {
        if (data.preferences) delete data.preferences;
        found.push(data);
      } else {
        skipped.push("a file that is not a calibration");
      }
    }
    const stored = await this._all();
    const groups = new Map();
    for (const profile of found) {
      const problems = this._problemsOf(profile);
      if (problems.length) { skipped.push(`${(profile && profile.site) || "a profile"} (${problems.join(", ")})`); continue; }
      const site = this._siteOf(profile.site) || { id: profile.site, name: profile.site };
      const group = groups.get(site.id) || { id: site.id, name: site.name, profiles: [], replaces: false };
      group.profiles = group.profiles.filter((existing) => existing.site !== profile.site).concat(profile); // the last one for a host wins
      group.replaces = group.replaces || !!stored[profile.site];
      groups.set(site.id, group);
    }
    return { groups: [...groups.values()], skipped, preferences: filePrefs };
  }

  /** Store these profiles (already checked by `read`) in one write; the others are kept. */
  async saveAll(profiles, prefs = null) {
    await this._store.set(KEY, { ...(await this._all()), ...Object.fromEntries(profiles.map((profile) => [profile.site, profile])) });
    await this._applyPrefs(prefs);
  }
}
