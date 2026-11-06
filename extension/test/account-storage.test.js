// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AccountStore } from "../src/application/account-store.js";
import { AccountSwitcher } from "../src/application/account-switcher.js";
import { createAccountStorage } from "../src/page/account-storage.js";
import { accountHostsOf, accountSiteFor, accountStorageOf, siteFor } from "../src/sites/registry.js";

const memoryStore = () => { const data = {}; return { get: async (key) => data[key], set: async (key, value) => { data[key] = value; } }; };
const emptyJar = { getAll: async () => [], remove: async () => {}, set: async () => {} };

// A page's localStorage, as the content script would expose it to the background.
function fakePage(initial) {
  const data = { ...initial };
  return { data, read: async () => ({ ...data }), write: async (entries) => { for (const [key, value] of Object.entries(entries)) { if (value === null) delete data[key]; else data[key] = value; } } };
}

function switcherOver(page) {
  const store = new AccountStore({ store: memoryStore() });
  const reloads = [];
  return { store, reloads, switcher: new AccountSwitcher({ store, cookies: emptyJar, hosts: ["deepseek.com"], pageStorage: page, reloadTabs: async () => { reloads.push(1); } }) };
}

describe("DeepSeek accounts", () => {
  test("the registry offers accounts for DeepSeek: its host, and the token it keeps in localStorage", () => {
    assert.equal(accountSiteFor("chat.deepseek.com").id, "deepseek");
    assert.deepEqual(accountHostsOf(siteFor("chat.deepseek.com")), ["deepseek.com"]);
    assert.deepEqual(accountStorageOf(siteFor("chat.deepseek.com")), ["userToken"]);
    assert.deepEqual(accountStorageOf(siteFor("claude.ai")), []);
  });

  test("the page only reads and writes the keys the site allows, and null removes one", () => {
    const map = new Map([["userToken", "t1"], ["secret", "s"]]);
    const area = { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
    const access = createAccountStorage({ area, allowed: ["userToken"] });
    assert.deepEqual(access.read(["userToken", "secret", "missing"]), { userToken: "t1" });
    assert.equal(access.write({ userToken: "t2", secret: "x" }), 1);
    assert.deepEqual([map.get("userToken"), map.get("secret")], ["t2", "s"]);
    access.write({ userToken: null });
    assert.equal(map.has("userToken"), false);
  });

  test("a login that lives only in page storage can be saved, and a site with nothing at all cannot", async () => {
    const t = switcherOver(fakePage({ userToken: "tok-a" }));
    assert.equal((await t.switcher.capture("deepseek", "Work")).ok, true);
    assert.equal((await t.store.get("deepseek", "work")).storage.userToken, "tok-a");
    const empty = switcherOver(fakePage({}));
    assert.match((await empty.switcher.capture("deepseek", "Work")).error, /no session to save/);
  });

  test("switching saves the token in use, puts the other one back and reloads", async () => {
    const page = fakePage({ userToken: "tok-a" });
    const t = switcherOver(page);
    await t.switcher.capture("deepseek", "Work");
    page.data.userToken = "tok-b";
    await t.switcher.capture("deepseek", "Home");
    const result = await t.switcher.activate("deepseek", "work");
    assert.deepEqual([result.ok, result.captured], [true, true]);
    assert.equal(page.data.userToken, "tok-a");
    assert.equal((await t.store.get("deepseek", "home")).storage.userToken, "tok-b", "the session in use was saved before it was replaced");
    assert.equal(t.reloads.length, 1);
  });

  test("signing out removes the token from the page and keeps the saved login", async () => {
    const page = fakePage({ userToken: "tok-a" });
    const t = switcherOver(page);
    await t.switcher.capture("deepseek", "Work");
    assert.equal((await t.switcher.clear("deepseek")).ok, true);
    assert.deepEqual(page.data, {});
    assert.deepEqual(await t.switcher.inspectStorage(), []);
    assert.equal((await t.store.list("deepseek")).accounts.length, 1);
  });
});
