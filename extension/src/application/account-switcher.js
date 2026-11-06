// SPDX-License-Identifier: GPL-3.0-or-later
// Switching the login a site sees: save the cookies the site has now, then put another account's cookies back. Nothing is
// logged out on the server, which is why the other account is still there when it is switched back to. Orchestration over a
// cookie port; the browser calls themselves live in the background worker.

import { cookiesFor, cookieWriteSpec } from "../domain/accounts/account.js";

export class AccountSwitcher {
  /**
   * @param {{ store: import("./account-store.js").AccountStore,
   *           cookies: { getAll: (details: object) => Promise<object[]>, remove: (details: object) => Promise<*>, set: (details: object) => Promise<*> },
   *           hosts: string[],                 the site's host names; a cookie of any of them is part of the session
   *           reloadTabs?: () => Promise<void>, called once the cookies are in place
   *           log?: (message: string) => void }} deps
   */
  constructor({ store, cookies, hosts, pageStorage = { read: async () => ({}), write: async () => {} }, reloadTabs = async () => {}, log = () => {} }) {
    Object.assign(this, { _store: store, _cookies: cookies, _hosts: hosts, _page: pageStorage, _reload: reloadTabs, _log: log });
  }

  /** The cookies of the session the site has right now. */
  async _current() {
    const found = [];
    for (const host of this._hosts) {
      try { found.push(...(await this._cookies.getAll({ domain: host }))); } catch (error) { this._log(`cookies of ${host} not read: ${error}`); }
    }
    return cookiesFor(found, this._hosts);
  }

  /**
   * Save the session the site has now under `name`, and remember that this is the session in use: what was just captured is
   * what the site is showing, so a later switch knows whose cookies to save first instead of overwriting a stale account.
   */
  async capture(site, name) {
    const current = await this._current();
    const pageValues = await this._page.read();
    if (!current.length && !Object.keys(pageValues).length) return { ok: false, error: "There is no session to save on this site right now." };
    const saved = await this._store.save(site, name, current, pageValues);
    if (saved.ok) await this._store.setActive(site, saved.id);
    return saved;
  }

  /**
   * Sign the site out on THIS browser only: its cookies are removed and the page reloaded. Nothing is logged out on the server,
   * so the account can be switched back to. The account in use becomes unknown: the next Save says which one it is.
   */
  async clear(site) {
    const current = await this._current();
    for (const cookie of current) {
      const spec = cookieWriteSpec(cookie);
      if (!spec) continue;
      try { await this._cookies.remove({ url: spec.url, name: cookie.name }); } catch (error) { this._log(`cookie ${cookie.name} not removed: ${error}`); }
    }
    await this._clearPage();
    await this._store.setActive(site, null);
    await this._reload();
    return { ok: true, removed: current.length };
  }

  /** The names of the page-storage keys that hold a value right now. */
  async inspectStorage() {
    return Object.keys(await this._page.read());
  }

  /** Remove the login keys the page holds in localStorage, so a signed-out browser keeps no token. */
  async _clearPage() {
    const now = await this._page.read();
    await this._page.write(Object.fromEntries(Object.keys(now).map((key) => [key, null])));
  }

  /** The cookie names the site has right now, per host: enough to see whether a switch is looking at the right jar. */
  async inspect() {
    const out = [];
    for (const host of this._hosts) {
      let names;
      try { names = (await this._cookies.getAll({ domain: host })).map((cookie) => cookie.name).sort(); }
      catch (error) { names = [`(not readable: ${(error && error.message) || error})`]; }
      out.push({ host, names });
    }
    return out;
  }

  /**
   * Give the site the cookies of `id`. The session it has now is saved first when it is a known account, so switching away
   * never loses a login; when it is unknown there is no name to save it under, and it is replaced (said so by `captured`).
   */
  async activate(site, id) {
    const { active } = await this._store.list(site);
    const target = await this._store.get(site, id);
    if (!target) return { ok: false, error: "That account is not saved any more." };
    const current = await this._current();
    const pageNow = await this._page.read();
    let captured = false;
    if (active && active !== id) {
      const previous = await this._store.get(site, active);
      if (previous) captured = !!(await this._store.save(site, previous.name, current, pageNow)).ok;
    }
    // The old session goes first: a cookie written over one of the same name is replaced, but one the target account does not
    // have would stay behind and mix the two logins.
    for (const cookie of current) {
      const spec = cookieWriteSpec(cookie);
      if (!spec) continue;
      try { await this._cookies.remove({ url: spec.url, name: cookie.name }); } catch (error) { this._log(`cookie ${cookie.name} not removed: ${error}`); }
    }
    let written = 0;
    const failed = [];
    for (const cookie of target.cookies || []) {
      const spec = cookieWriteSpec(cookie);
      if (!spec) { failed.push(cookie.name); continue; }
      try { await this._cookies.set(spec); written += 1; } catch (error) { failed.push(cookie.name); this._log(`cookie ${cookie.name} not written: ${error}`); }
    }
    const targetPage = target.storage || {};
    if (!written && !Object.keys(targetPage).length) return { ok: false, error: "None of that account's cookies could be written back. Reload the page and try again.", failed };
    // Keys the target account does not have are removed first, for the same reason the old cookies go: no mixed logins.
    await this._page.write({ ...Object.fromEntries(Object.keys(pageNow).map((key) => [key, null])), ...targetPage });
    await this._store.setActive(site, id);
    await this._reload();
    return { ok: true, written, failed, captured, active: id };
  }
}
