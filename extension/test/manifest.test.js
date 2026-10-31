import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManifest, contentScripts, hostPermissions } from "../build/manifest.mjs";
import { SITES, allHostnames, allMatches } from "../src/sites/registry.js";

const base = JSON.parse(readFileSync(new URL("../manifests/base.json", import.meta.url), "utf8"));
const chrome = buildManifest(base, { target: "chrome", version: "9.9.9" });
const firefox = buildManifest(base, { target: "firefox", version: "9.9.9" });

describe("site registry", () => {
  test("ids and match patterns are unique", () => {
    assert.equal(new Set(SITES.map((s) => s.id)).size, SITES.length);
    assert.equal(new Set(allMatches()).size, allMatches().length);
  });

  test("hostnames cover every site", () => {
    const hosts = allHostnames();
    for (const host of ["chatgpt.com", "claude.ai", "chat.deepseek.com", "deepseek.com", "grok.com"]) assert.ok(hosts.includes(host), host);
  });
});

describe("manifest generation", () => {
  test("every site gets exactly one isolated-world content script with core scripts around its adapter", () => {
    for (const site of SITES) {
      const entries = chrome.content_scripts.filter((c) => !c.world && c.matches === site.matches);
      assert.equal(entries.length, 1, site.id);
      assert.deepEqual(entries[0].js, ["globals.js", `providers/${site.id}.js`, "main.js"]);
    }
  });

  test("MAIN-world scripts run at document_start", () => {
    const main = contentScripts().filter((c) => c.world === "MAIN");
    assert.deepEqual(main.flatMap((c) => c.js).sort(), ["providers/chatgpt-cm.js", "providers/qwen-net.js"]);
    assert.ok(main.every((c) => c.run_at === "document_start"));
  });

  test("host permissions include sites and the local bridge only", () => {
    const perms = hostPermissions();
    assert.ok(perms.includes("ws://127.0.0.1/*") && perms.includes("http://127.0.0.1/*"));
    for (const match of allMatches()) assert.ok(perms.includes(match));
  });

  test("Chrome uses a service worker, Firefox an event page with a gecko id", () => {
    assert.deepEqual(chrome.background, { service_worker: "background.js" });
    assert.deepEqual(firefox.background, { scripts: ["background.js"] });
    assert.ok(firefox.browser_specific_settings.gecko.id);
    assert.equal(chrome.browser_specific_settings, undefined);
  });

  test("version is injected and unknown targets are rejected", () => {
    assert.equal(chrome.version, "9.9.9");
    assert.throws(() => buildManifest(base, { target: "safari", version: "1" }));
  });
});
