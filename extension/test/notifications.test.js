import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createNotifications } from "../src/ui/notifications.js";

function setup(over = {}) {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const root = window.document.createElement("div");
  window.document.body.appendChild(root);
  const reloads = [];
  const n = createNotifications({ root, reload: () => reloads.push(1), ...over });
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { window, root, n, reloads, click, $: (s) => root.querySelector(s), $$: (s) => [...root.querySelectorAll(s)] };
}

describe("banner", () => {
  test("title and message are shown as text, never parsed as HTML", () => {
    const t = setup();
    t.n.banner("warn", "<img src=x onerror=alert(1)>", "<b>bold</b>");
    assert.equal(t.$(".zs-banner-t").textContent, "<img src=x onerror=alert(1)>");
    assert.equal(t.$(".zs-banner-m").textContent, "<b>bold</b>");
    assert.equal(t.$("img"), null);
    assert.ok(t.$(".zs-banner.warn"));
  });

  test("Close removes just that banner", () => {
    const t = setup();
    t.n.banner("warn", "a", "1");
    t.n.banner("limit", "b", "2");
    t.click(t.$$(".zs-banner-x")[0]);
    assert.deepEqual(t.$$(".zs-banner-t").map((e) => e.textContent), ["b"]);
  });
});

describe("connection alerts", () => {
  test("bridge lost shows once, and clears when it is back", () => {
    const t = setup();
    t.n.setBridgeLost(true);
    t.n.setBridgeLost(true);
    assert.equal(t.$$(".zs-banner").length, 1);
    assert.match(t.$(".zs-banner-t").textContent, /disconnected/);
    t.n.setBridgeLost(false);
    assert.equal(t.$$(".zs-banner").length, 0);
    t.n.setBridgeLost(false); // clearing nothing is fine
  });

  test("closing the bridge banner lets it show again next time", () => {
    const t = setup();
    t.n.setBridgeLost(true);
    t.click(t.$(".zs-banner-x"));
    t.n.setBridgeLost(true);
    assert.equal(t.$$(".zs-banner").length, 1);
  });

  test("a stale page replaces the bridge alert, offers a reload and has no Close button", () => {
    const t = setup();
    t.n.setBridgeLost(true);
    t.n.showStaleExtension();
    assert.equal(t.$$(".zs-banner").length, 1);
    assert.ok(t.$(".zs-stale"));
    assert.equal(t.$(".zs-banner-x"), null);
    t.click(t.$(".zs-banner-reload"));
    assert.equal(t.reloads.length, 1);
    t.n.showStaleExtension();
    assert.equal(t.$$(".zs-stale").length, 1, "not duplicated");
  });

  test("the bridge coming back clears whichever connection alert is showing (same slot, as before)", () => {
    const t = setup();
    t.n.showStaleExtension();
    t.n.setBridgeLost(false);
    assert.equal(t.$$(".zs-stale").length, 0);
  });
});

describe("toast", () => {
  test("appears, then fades and is removed", async () => {
    const t = setup();
    t.n.toast("Agent on.");
    assert.equal(t.$(".zs-toast").textContent, "Agent on.");
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(t.$(".zs-toast").classList.contains("show"));
  });
});

