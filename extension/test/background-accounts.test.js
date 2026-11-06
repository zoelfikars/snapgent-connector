import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The background handler is written against chrome.*; a small stand-in for the three APIs it uses is enough to drive it.
// chrome.* answers through a callback here, the way older Firefox builds do: the handler accepts either form.
const message = (type, extra = {}) => ({ type, site: "claude", hosts: ["claude.ai"], ...extra });

async function withChrome(cookies, run) {
  const saved = {};
  let jar = cookies.map((cookie) => ({ ...cookie }));
  let reloads = 0;
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get: (key, done) => done({ [key]: saved[key] }),
      set: (items, done) => { Object.assign(saved, items); done && done(); },
    } },
    cookies: {
      getAll: ({ domain }, done) => done(jar.filter((c) => c.domain === domain || c.domain.endsWith(`.${domain}`))),
      remove: ({ name }, done) => { jar = jar.filter((c) => c.name !== name); done({}); },
      set: (spec, done) => { jar.push({ name: spec.name, value: spec.value, domain: spec.domain || new URL(spec.url).hostname, path: spec.path, secure: spec.secure }); done({}); },
    },
    tabs: {
      query: (_query, done) => done([{ id: 1 }, { id: 2 }]),
      reload: (_id, done) => { reloads += 1; done && done(); },
    },
  };
  try {
    const { handleAccountMessage } = await import(`../src/entry/background-accounts.js?t=${Date.now()}`);
    return await run({ handleAccountMessage, saved, jar: () => jar, reloads: () => reloads });
  } finally {
    delete globalThis.chrome;
  }
}

const session = { name: "sessionKey", value: "sk-a", domain: "claude.ai", hostOnly: true, path: "/", secure: true, httpOnly: true, session: true };

describe("accounts in the background worker", () => {
  test("a message that is not about accounts is left to the bridge", async () => {
    await withChrome([], async ({ handleAccountMessage }) => {
      assert.equal(await handleAccountMessage({ type: "status" }), undefined);
      assert.equal(await handleAccountMessage(null), undefined);
    });
  });

  test("a message without a site is refused instead of guessing one", async () => {
    await withChrome([], async ({ handleAccountMessage }) => {
      assert.match((await handleAccountMessage({ type: "accounts_list" })).error, /No site/);
      assert.match((await handleAccountMessage({ type: "accounts_capture", site: "claude" })).error, /No site/);
    });
  });

  test("saving a login, listing it, and switching back to it are answered without cookie values", async () => {
    await withChrome([session], async ({ handleAccountMessage, jar, reloads }) => {
      const saved = await handleAccountMessage(message("accounts_capture", { name: "Work" }));
      assert.equal(saved.ok, true);
      const list = await handleAccountMessage(message("accounts_list"));
      assert.deepEqual(list.accounts.map((a) => [a.id, a.name, a.cookies]), [["work", "Work", 1]]);
      assert.equal(JSON.stringify(list).includes("sk-a"), false, "a cookie value never travels to the popup");
      jar().length = 0;
      jar().push({ ...session, value: "sk-other" });
      const switched = await handleAccountMessage(message("accounts_activate", { id: "work" }));
      assert.equal(switched.ok, true);
      assert.deepEqual(jar().map((c) => c.value), ["sk-a"]);
      assert.equal(reloads(), 2, "every tab of the site is reloaded");
      assert.equal((await handleAccountMessage(message("accounts_list"))).active, "work");
    });
  });

  test("switching to a login that is gone, and a failure inside the browser, are answers not exceptions", async () => {
    await withChrome([session], async ({ handleAccountMessage }) => {
      assert.match((await handleAccountMessage(message("accounts_activate", { id: "nobody" }))).error, /not saved any more/);
      assert.match((await handleAccountMessage(message("accounts_nope"))).error, /unknown account message/);
    });
  });

  test("signing out in this browser clears the cookies but keeps the saved login, and inspect says what is there", async () => {
    await withChrome([session], async ({ handleAccountMessage, jar }) => {
      await handleAccountMessage(message("accounts_capture", { name: "Work" }));
      const inspected = await handleAccountMessage(message("accounts_inspect"));
      assert.deepEqual(inspected.hosts, [{ host: "claude.ai", names: ["sessionKey"] }]);
      const signedOut = await handleAccountMessage(message("accounts_signout"));
      assert.deepEqual([signedOut.ok, signedOut.removed], [true, 1]);
      assert.deepEqual(jar(), []);
      const list = await handleAccountMessage(message("accounts_list"));
      assert.deepEqual([list.accounts.length, list.active], [1, null]);
    });
  });

  test("forgetting a login removes it and its cookies", async () => {
    await withChrome([session], async ({ handleAccountMessage, saved }) => {
      await handleAccountMessage(message("accounts_capture", { name: "Work" }));
      assert.equal((await handleAccountMessage(message("accounts_remove", { id: "work" }))).ok, true);
      assert.deepEqual((await handleAccountMessage(message("accounts_list"))).accounts, []);
      assert.equal(JSON.stringify(saved.zsAccounts).includes("sk-a"), false, "the cookies are gone from storage too");
    });
  });
});
