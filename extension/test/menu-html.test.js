import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { switchMenuHtml, targetMenuHtml, workspaceMenuHtml } from "../src/ui/menu-html.js";

const parse = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const NASTY = { id: 'a"><img src=x onerror=1>', name: "<b>Bold</b> & 'quotes'" };

describe("target menus", () => {
  test("the menu lists every option and badges only the active one", () => {
    const doc = parse(targetMenuHtml([{ id: "snapgent", name: "VS Code" }, NASTY], "snapgent"));
    const rows = [...doc.querySelectorAll(".zs-target-opt")];
    assert.deepEqual(rows.map((r) => r.dataset.id), ["snapgent", NASTY.id]);
    assert.deepEqual(rows.map((r) => r.classList.contains("zs-target-cur")), [true, false]);
    assert.equal(doc.querySelectorAll(".zs-site-badge").length, 1);
    assert.equal(doc.querySelector("img, b"), null, "nothing a server name says becomes markup");
  });
});

describe("switch AI menu", () => {
  const sites = [{ name: "ChatGPT", url: "https://chatgpt.com/" }, { name: "Claude", url: "https://www.claude.ai/" }];

  test("the current site is badged and not a link, the others open their url", () => {
    const doc = parse(switchMenuHtml(sites, "chatgpt"));
    assert.equal(doc.querySelectorAll(".zs-site-here").length, 1);
    assert.match(doc.querySelector(".zs-site-here").textContent, /ChatGPT/);
    const link = doc.querySelector("button.zs-site-opt");
    assert.equal(link.dataset.u, "https://www.claude.ai/");
    assert.equal(link.querySelector(".zs-site-host").textContent, "claude.ai", "www. is dropped from the shown host");
  });

  test("survives an unknown current site and a bad url", () => {
    const doc = parse(switchMenuHtml([{ name: "Odd", url: "not a url" }], undefined));
    assert.equal(doc.querySelector(".zs-site-host").textContent, "");
    assert.equal(doc.querySelectorAll(".zs-site-here").length, 0);
  });
});

describe("the workspace menu", () => {
  const rows = (doc) => [...doc.querySelectorAll(".zs-ws-opt")].map((row) => row.dataset.path);

  test("the folders used lately are listed after the open ones, once each, under their own heading", () => {
    const doc = parse(workspaceMenuHtml({ active: null, open: ["/work/a"], pinned: null, recent: ["/work/a", "/work/r1"] }));
    assert.deepEqual(rows(doc), ["", "/work/a", "/work/r1"], "\"\" is Auto; the folder already open is not listed twice");
    assert.match(doc.body.textContent, /Used lately/);
    assert.equal(doc.querySelector(".zs-ws-opt[data-path='/work/r1'] .zs-site-host").textContent, "/work/r1");
  });

  test("with nothing used lately there is no 'Used lately' heading", () => {
    const doc = parse(workspaceMenuHtml({ active: "/work/a", open: ["/work/a"], pinned: null }));
    assert.deepEqual(rows(doc), ["", "/work/a"]);
    assert.doesNotMatch(doc.body.textContent, /Used lately/);
  });

  test("the folder this chat already uses is not repeated among the recent ones", () => {
    const doc = parse(workspaceMenuHtml({ active: null, open: [], pinned: null, recent: ["/work/r1", "/work/r2"] }));
    const doc2 = parse(workspaceMenuHtml({ active: null, open: [], pinned: "/work/r1", recent: ["/work/r1", "/work/r2"] }));
    assert.deepEqual(rows(doc), ["", "/work/r1", "/work/r2"]);
    assert.deepEqual(rows(doc2), ["", "/work/r1", "/work/r2"], "the pinned one is shown once, among the recent");
  });
});

describe("what the switch AI menu leaves out", () => {
  test("only the AI list and the settings gears: the bar and calibration rows live in Preferences", () => {
    const sites = [{ name: "ChatGPT", url: "https://chatgpt.com/" }];
    const doc = parse(switchMenuHtml(sites, "chatgpt"));
    assert.ok(doc.querySelector(".zs-site-grid"));
    for (const id of ["zs-bar-corner", "zs-bar-hide", "zs-cal-start", "zs-cal-export-all", "zs-prefs", "zs-skills-settings", "zs-mcp-settings"]) {
      assert.equal(doc.querySelector(`#${id}`), null, id);
    }
  });
});
