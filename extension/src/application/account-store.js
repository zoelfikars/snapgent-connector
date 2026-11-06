// SPDX-License-Identifier: GPL-3.0-or-later
// Where the saved logins live: one object in extension storage, kept per site and per account. A login is sensitive, so this
// is never exported, never synced, and removing an account removes its cookies. Reading never rejects: a page can outlive
// its extension (reload, update) and every call then throws.

import { accountId, nameProblem } from "../domain/accounts/account.js";

export const KEY = "zsAccounts";

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** One site's entry, in the shape the rest of this module expects. */
function siteEntry(entry) {
  const accounts = isObject(entry) && isObject(entry.accounts) ? entry.accounts : {};
  const active = isObject(entry) && typeof entry.active === "string" ? entry.active : null;
  return { active, accounts };
}

export class AccountStore {
  /** @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: *) => Promise<void>|void } }} deps */
  constructor({ store }) {
    this._store = store;
  }

  async _all() {
    const saved = await this._store.get(KEY);
    return isObject(saved) ? saved : {};
  }

  async _site(site) {
    return siteEntry((await this._all())[site]);
  }

  async _write(site, entry) {
    const all = await this._all();
    all[site] = entry;
    await this._store.set(KEY, all);
  }

  /** The accounts of one site, the latest first, and which one was last used (as far as Snapgent knows). */
  async list(site) {
    const { active, accounts } = await this._site(site);
    return { active, accounts: Object.values(accounts).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)) };
  }

  async get(site, id) {
    return (await this._site(site)).accounts[id] || null;
  }

  /** Store these cookies under a name; an existing name (same id) is replaced. */
  async save(site, name, cookies) {
    const problem = nameProblem(name);
    if (problem) return { ok: false, error: problem };
    const id = accountId(name);
    const { active, accounts } = await this._site(site);
    await this._write(site, { active, accounts: { ...accounts, [id]: { id, name: String(name).trim(), savedAt: Date.now(), cookies } } });
    return { ok: true, id };
  }

  /** Forget an account, and with it its cookies. An account in use is no longer marked as such. */
  async remove(site, id) {
    const { active, accounts } = await this._site(site);
    const { [id]: _gone, ...rest } = accounts;
    await this._write(site, { active: active === id ? null : active, accounts: rest });
    return { ok: true };
  }

  async setActive(site, id) {
    const { active, accounts } = await this._site(site);
    const next = id && accounts[id] ? id : null;
    await this._write(site, { active: next, accounts });
    return { ok: true, active: next };
  }
}
