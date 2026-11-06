import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { accountId, accountSummary, cookiesFor, cookieWriteSpec, cookieBelongsTo, nameProblem } from "../src/domain/accounts/account.js";
import { AccountStore } from "../src/application/account-store.js";
import { AccountSwitcher } from "../src/application/account-switcher.js";
import { matchingTab } from "../src/application/account-tab.js";
import { accountHostsOf, accountSiteFor, siteFor } from "../src/sites/registry.js";

const HOSTS = ["claude.ai", "anthropic.com"];
const session = { name: "sessionKey", value: "sk-a", domain: "claude.ai", hostOnly: true, path: "/", secure: true, httpOnly: true, session: true, sameSite: "lax" };

function memoryStore(initial = {}) {
  const data = { ...initial };
  return { data, get: async (key) => data[key], set: async (key, value) => { data[key] = value; } };
}

function cookieJar(cookies = []) {
  const jar = cookies.map((cookie) => ({ ...cookie }));
  const calls = { removed: [], set: [] };
  return {
    calls, jar,
    getAll: async ({ domain }) => jar.filter((cookie) => cookie.domain === domain || cookie.domain.endsWith(`.${domain}`)),
    remove: async ({ url, name }) => { calls.removed.push(name); const i = jar.findIndex((c) => c.name === name); if (i >= 0) jar.splice(i, 1); },
    set: async (spec) => { calls.set.push(spec.name); jar.push({ name: spec.name, value: spec.value, domain: spec.domain || new URL(spec.url).hostname, path: spec.path }); },
  };
}

function switcher({ store = new AccountStore({ store: memoryStore() }), jar = cookieJar([session]), reload } = {}) {
  const reloads = [];
  const instance = new AccountSwitcher({ store, cookies: jar, hosts: HOSTS, reloadTabs: async () => { reloads.push(1); if (reload) await reload(); } });
  return { store, jar, reloads, switcher: instance };
}

describe("accounts: naming and the cookies of a login", () => {
  test("a name becomes a stable id and a name with nothing usable in it is refused", () => {
    assert.deepEqual([accountId("Work"), accountId("work 2"), accountId("  Kerja/B ")], ["work", "work-2", "kerja-b"]);
    for (const bad of ["", "   ", "---", null]) assert.ok(nameProblem(bad), String(bad));
    assert.equal(nameProblem("Work"), null);
  });

  test("only the cookies of the site's hosts belong to the login, subdomains included", () => {
    const jars = [session, { name: "x", value: "1", domain: ".claude.ai" }, { name: "y", value: "1", domain: "api.anthropic.com" }, { name: "z", value: "1", domain: "example.com" }];
    assert.deepEqual(cookiesFor(jars, HOSTS).map((c) => c.name), ["sessionKey", "x", "y"]);
    assert.equal(cookieBelongsTo(jars[3], HOSTS), false);
    assert.equal(cookieBelongsTo(jars[0], ["claude.ai.evil.test"]), false, "a host that merely ends in the name is not the site");
  });

  test("a cookie is written back in the exact shape the browser accepts", () => {
    assert.deepEqual(cookieWriteSpec(session), { url: "https://claude.ai/", name: "sessionKey", value: "sk-a", path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    const shared = cookieWriteSpec({ name: "a", value: "b", domain: ".claude.ai", path: "/app", secure: false, hostOnly: false, expirationDate: 123 });
    assert.deepEqual([shared.url, shared.domain, shared.path, shared.expirationDate], ["http://claude.ai/app", "claude.ai", "/app", 123]);
    // __Host- cookies are only accepted secure, host-only and on "/": anything else is refused by the browser and the login is lost.
    const host = cookieWriteSpec({ name: "__Host-token", value: "t", domain: "claude.ai", path: "/deep", secure: false, hostOnly: false });
    assert.deepEqual([host.url, host.path, host.secure, "domain" in host], ["https://claude.ai/", "/", true, false]);
    assert.equal(cookieWriteSpec({ name: "", value: "x", domain: "claude.ai" }), null);
  });

  test("the summary the popup gets carries no cookie value", () => {
    const summary = accountSummary({ id: "work", name: "Work", savedAt: 5, cookies: [session] });
    assert.deepEqual(summary, { id: "work", name: "Work", savedAt: 5, cookies: 1 });
    assert.equal(JSON.stringify(summary).includes("sk-a"), false);
  });

  test("Claude is the site with accounts for now, and its cookies are its two host names", () => {
    assert.equal(accountSiteFor("claude.ai").id, "claude");
    assert.equal(accountSiteFor("chatgpt.com"), undefined);
    assert.deepEqual(accountHostsOf(siteFor("claude.ai")), ["claude.ai", "anthropic.com"]);
  });
});

describe("accounts: which tab the switch reloads", () => {
  const entry = siteFor("claude.ai");
  const tab = (url, active = true, id = 1) => ({ id, url, active });

  test("the active tab of the site is found, from the site's own match patterns", () => {
    assert.equal(matchingTab(entry, [tab("https://example.com/"), tab("https://claude.ai/chat/1", true, 7)]).id, 7);
    assert.equal(matchingTab(entry, [tab("https://claude.ai/chat/1", false)]), null, "a background tab is not the page the user is on");
  });

  test("a tab of another site never matches, so its page shows no accounts", () => {
    const deepseek = { id: 3, active: true, url: "https://chat.deepseek.com/a/chat" };
    assert.equal(matchingTab(entry, [deepseek]), null, "Claude's accounts are not offered on DeepSeek's page");
    assert.equal(siteFor("chat.deepseek.com").accounts, true, "DeepSeek has its own accounts, apart from Claude's");
  });

  test("an id is not a site entry, and a site that is not open has no tab", () => {
    assert.equal(matchingTab("claude", [tab("https://claude.ai/")]), null, "the popup once passed the id here: that must fail quietly, not hang");
    assert.equal(matchingTab(entry, []), null);
    assert.equal(matchingTab(entry, [tab(undefined)]), null);
  });
});

describe("accounts: where they are kept", () => {
  test("saving the same name twice replaces it, the latest is listed first, and removing drops only that one", async () => {
    const store = new AccountStore({ store: memoryStore() });
    await store.save("claude", "Work", [session]);
    await store.save("claude", "Home", [{ ...session, name: "homeKey" }]);
    await store.save("claude", "Work", [{ ...session, value: "new" }]);
    const { accounts } = await store.list("claude");
    assert.deepEqual(accounts.map((a) => a.id), ["work", "home"]);
    assert.equal(accounts[0].cookies[0].value, "new");
    await store.remove("claude", "home");
    assert.deepEqual((await store.list("claude")).accounts.map((a) => a.id), ["work"]);
  });

  test("a bad name is refused and nothing is stored", async () => {
    const store = new AccountStore({ store: memoryStore() });
    assert.equal((await store.save("claude", "  ", [session])).ok, false);
    assert.deepEqual((await store.list("claude")).accounts, []);
  });

  test("the active account is forgotten when it is removed, and an unknown id cannot be made active", async () => {
    const store = new AccountStore({ store: memoryStore() });
    await store.save("claude", "Work", [session]);
    await store.setActive("claude", "work");
    assert.equal((await store.list("claude")).active, "work");
    await store.remove("claude", "work");
    assert.equal((await store.list("claude")).active, null);
    assert.equal((await store.setActive("claude", "nobody")).active, null);
  });

  test("one site's accounts are not another site's", async () => {
    const store = new AccountStore({ store: memoryStore() });
    await store.save("claude", "Work", [session]);
    assert.deepEqual((await store.list("chatgpt")).accounts, []);
  });
});

describe("accounts: switching", () => {
  test("switching saves the session in use, replaces the cookies and reloads the page", async () => {
    const t = switcher();
    await t.switcher.capture("claude", "Work");
    t.jar.jar.length = 0;
    t.jar.jar.push({ ...session, name: "sessionKey", value: "sk-home" });
    await t.switcher.capture("claude", "Home");
    await t.store.setActive("claude", "home");

    t.jar.jar.length = 0;
    t.jar.jar.push({ ...session, name: "sessionKey", value: "sk-home" });
    const result = await t.switcher.activate("claude", "work");
    assert.equal(result.ok, true);
    assert.equal(result.captured, true, "the session in use was saved before it was replaced");
    assert.deepEqual(t.jar.jar.map((c) => c.value), ["sk-a"]);
    assert.deepEqual(t.reloads, [1]);
    assert.deepEqual([result.written, result.failed, result.active], [1, [], "work"]);
    assert.equal((await t.store.list("claude")).active, "work");
  });

  test("a session that is not one of the saved accounts is replaced, and said so", async () => {
    const t = switcher();
    await t.switcher.capture("claude", "Work");
    t.jar.jar.push({ name: "otherKey", value: "x", domain: "claude.ai", path: "/" });
    const result = await t.switcher.activate("claude", "work");
    assert.equal(result.captured, false);
    assert.ok(!t.jar.jar.some((c) => c.name === "otherKey"), "a cookie the target account does not have does not stay behind");
  });

  test("nothing to capture, an unknown account, and cookies that cannot be written are each said plainly", async () => {
    const empty = switcher({ jar: cookieJar([]) });
    assert.match((await empty.switcher.capture("claude", "Work")).error, /no session to save/);
    const t = switcher();
    assert.match((await t.switcher.activate("claude", "nobody")).error, /not saved any more/);
    await t.switcher.capture("claude", "Work");
    t.jar.set = async () => { throw new Error("refused"); };
    const failed = await t.switcher.activate("claude", "work");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /could be written back/);
    assert.deepEqual(t.reloads, [], "a failed switch does not reload the page");
  });

  test("saving the session in use marks it as the account in use, so a later switch saves the right one", async () => {
    const t = switcher();
    await t.switcher.capture("claude", "Work");
    assert.equal((await t.store.list("claude")).active, "work");
    t.jar.jar.length = 0;
    t.jar.jar.push({ ...session, value: "sk-home" });
    await t.switcher.capture("claude", "Home");
    assert.equal((await t.store.list("claude")).active, "home");
  });

  test("signing this browser out removes every cookie of the site, forgets whose session it was, and reloads", async () => {
    const t = switcher();
    await t.switcher.capture("claude", "Work");
    t.jar.jar.push({ name: "extra", value: "x", domain: "anthropic.com", path: "/" });
    const result = await t.switcher.clear("claude");
    assert.deepEqual([result.ok, result.removed], [true, 2]);
    assert.deepEqual(t.jar.jar, []);
    assert.equal((await t.store.list("claude")).active, null, "the next Save says which account it is");
    assert.equal(t.reloads.length, 1, "one reload, after the cookies are gone");
    assert.equal((await t.store.list("claude")).accounts.length, 1, "the saved login itself is kept");
  });

  test("inspecting says which cookie names each host has, and why a host cannot be read", async () => {
    const t = switcher();
    t.jar.jar.push({ name: "x", value: "1", domain: "anthropic.com", path: "/" });
    assert.deepEqual(await t.switcher.inspect(), [{ host: "claude.ai", names: ["sessionKey"] }, { host: "anthropic.com", names: ["x"] }]);
    t.jar.getAll = async () => { throw new Error("no permission"); };
    assert.match((await t.switcher.inspect())[0].names[0], /not readable: no permission/);
  });

  test("activating the account that is already in use still writes it back (a reloaded page has lost nothing)", async () => {
    const t = switcher();
    await t.switcher.capture("claude", "Work");
    await t.store.setActive("claude", "work");
    const result = await t.switcher.activate("claude", "work");
    assert.deepEqual([result.ok, result.captured, t.reloads.length], [true, false, 1]);
  });
});
