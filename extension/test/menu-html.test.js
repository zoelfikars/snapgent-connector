import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { switchMenuHtml, targetMenuHtml } from "../src/ui/menu-html.js";

const parse = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const NASTY = { id: 'a"><img src=x onerror=1>', name: "<b>Bold</b> & 'quotes'" };

describe("target menus", () => {
  test("the menu lists every option and badges only the active one", () => {
    const doc = parse(targetMenuHtml([{ id: "vscode", name: "VS Code" }, NASTY], "vscode"));
    const rows = [...doc.querySelectorAll(".zs-target-opt")];
    assert.deepEqual(rows.map((r) => r.dataset.id), ["vscode", NASTY.id]);
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
