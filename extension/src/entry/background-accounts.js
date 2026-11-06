// SPDX-License-Identifier: GPL-3.0-or-later
// The account messages the popup sends. The cookies of a login can only be read and written here: the background worker is the
// one part of the extension that runs outside any page. Everything that is not a browser call lives in application/.

import { AccountStore } from "../application/account-store.js";
import { AccountSwitcher } from "../application/account-switcher.js";

// chrome.* answers through a callback in older Firefox builds and through a promise in Chrome: take whichever comes.
const call = (fn, arg) => new Promise((resolve, reject) => {
  const done = (value) => {
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(value);
  };
  try {
    const returned = fn(arg, done);
    if (returned && typeof returned.then === "function") returned.then(resolve, reject);
  } catch (error) {
    reject(error);
  }
});

const localStore = {
  get: (key) => call(chrome.storage.local.get.bind(chrome.storage.local), key).then((items) => (items ? items[key] : undefined)),
  set: (key, value) => call(chrome.storage.local.set.bind(chrome.storage.local), { [key]: value }),
};

const cookieJar = {
  getAll: (details) => call(chrome.cookies.getAll.bind(chrome.cookies), details),
  remove: (details) => call(chrome.cookies.remove.bind(chrome.cookies), details),
  set: (details) => call(chrome.cookies.set.bind(chrome.cookies), details),
};

/** Reload every tab of the site, so the page is drawn against the login that was just put back. */
function reloadTabs(hosts) {
  return new Promise((resolve) => {
    try {
      const query = { url: hosts.map((host) => `*://*.${host.replace(/^\./, "")}/*`) };
      chrome.tabs.query(query, (tabs) => {
        for (const tab of tabs || []) chrome.tabs.reload(tab.id, () => void (chrome.runtime && chrome.runtime.lastError));
        resolve();
      });
    } catch { resolve(); }
  });
}

function switcherFor(site, hosts) {
  return new AccountSwitcher({
    store: new AccountStore({ store: localStore }), cookies: cookieJar, hosts,
    reloadTabs: () => reloadTabs(hosts), log: (message) => console.warn("[zs-bg]", message),
  });
}

const missing = (msg) => (!msg.site || !Array.isArray(msg.hosts) || !msg.hosts.length ? { ok: false, error: "No site to keep accounts for." } : null);

/**
 * Answer one `accounts_*` message, or return undefined when it is not one.
 * @param {{ type: string, site?: string, hosts?: string[], id?: string, name?: string }} msg
 */
export async function handleAccountMessage(msg) {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("accounts_")) return undefined;
  const problem = missing(msg);
  if (problem) return problem;
  const store = new AccountStore({ store: localStore });
  try {
    switch (msg.type) {
      case "accounts_list": {
        const { active, accounts } = await store.list(msg.site);
        return { ok: true, active, accounts: accounts.map(({ id, name, savedAt, cookies }) => ({ id, name, savedAt, cookies: (cookies || []).length })) };
      }
      case "accounts_capture":
        return switcherFor(msg.site, msg.hosts).capture(msg.site, msg.name);
      case "accounts_activate": {
        const store2 = new AccountStore({ store: localStore });
        const saved = await store2.get(msg.site, msg.id);
        if (!saved) return { ok: false, error: "That account is not saved any more." };
        return switcherFor(msg.site, msg.hosts).activate(msg.site, msg.id);
      }
      case "accounts_remove":
        return store.remove(msg.site, msg.id);
      case "accounts_signout":
        return switcherFor(msg.site, msg.hosts).clear(msg.site);
      case "accounts_inspect":
        return { ok: true, hosts: await switcherFor(msg.site, msg.hosts).inspect() };
      default:
        return { ok: false, error: "unknown account message" };
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
