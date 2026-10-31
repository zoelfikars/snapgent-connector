// Runs the REAL extension (bundled globals.js + the ChatGPT adapter + main.js) against captured page
// markup in a real DOM. Catches what unit tests cannot: the pieces not fitting together on a page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const root = new URL("../", import.meta.url).pathname;
const source = (path) => readFileSync(root + path, "utf8");

async function bundledGlobals() {
  const result = await build({ entryPoints: [root + "src/entry/legacy-globals.js"], bundle: true, format: "iife", write: false, logLevel: "silent" });
  return result.outputFiles[0].text;
}

async function startOn(html, url = "https://chatgpt.com/c/test") {
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn", (...args) => warnings.push(args.join(" ")));
  virtualConsole.on("jsdomError", (error) => warnings.push(String(error)));
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.chrome = {
    storage: { local: { get: (_key, callback) => callback && callback({}), set() {} } },
    // A bridge that is connected with a live VS Code server but advertises no tools yet.
    runtime: {
      sendMessage: (message, callback) => callback && callback(
        message.type === "status" ? { connected: true, mcpAlive: true, tools: 0, servers: [{ id: "vscode", alive: true, tools: 3 }] }
        : message.type === "list_tools" ? { ok: true, tools: [] }
        : { ok: true },
      ),
      onMessage: { addListener() {} },
      lastError: null,
    },
  };
  // Classic scripts share one global lexical scope, as in a real content script.
  const context = dom.getInternalVMContext();
  const run = (code, filename) => new vm.Script(code, { filename }).runInContext(context);
  run(await bundledGlobals(), "globals.js");
  run(source("legacy/providers/uncalibrated.js"), "uncalibrated.js");
  run(source("legacy/main.js"), "main.js");
  await new Promise((resolve) => setTimeout(resolve, 1200)); // let the first camouflage sweep run
  return { window, document: window.document, warnings, count: (selector) => window.document.querySelectorAll(selector).length };
}

// Until a site is calibrated (docs/CALIBRATION.md) the extension must still boot cleanly and say why it cannot start.
describe("content script on a supported site that is not calibrated yet", () => {
  test("shows the bar, keeps Start disabled with the reason, draws no chips and logs no warnings", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      assert.deepEqual(page.warnings, []);
      assert.ok(page.document.getElementById("zs-bar"), "the bar is there");
      assert.match(page.document.getElementById("zs-state").textContent, /Not calibrated for this site yet/);
      assert.equal(page.document.getElementById("zs-action").disabled, true);
      assert.equal(page.count(".zs-chip"), 0);
    } finally {
      page.window.close(); // stops the content script's timers even when an assertion failed
    }
  });

  test("the switch-AI shortcut list is still there, with the current site marked", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      page.document.getElementById("zs-switch").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const menu = page.document.getElementById("zs-menu");
      assert.ok(menu.querySelectorAll("button.zs-site-opt").length >= 5, "links to the other chat sites");
      assert.match(menu.querySelector(".zs-site-here").textContent, /ChatGPT/);
    } finally {
      page.window.close();
    }
  });

  test("the name shown is the site's own, taken from the registry by host name", async () => {
    const page = await startOn("<html><body></body></html>", "https://gemini.google.com/app/x");
    try {
      assert.equal(page.document.getElementById("zs-switch-name").textContent.trim(), "Gemini");
    } finally {
      page.window.close();
    }
  });
});

describe("content script on a page it does not understand", () => {
  test("starts quietly and draws nothing", async () => {
    const page = await startOn("<html><body><main><p>some other page</p></main></body></html>");
    try {
      assert.deepEqual(page.warnings, []);
      assert.equal(page.count(".zs-chip"), 0);
    } finally {
      page.window.close();
    }
  });
});
