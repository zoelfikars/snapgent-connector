// Runs the REAL extension (bundled globals.js + the ChatGPT adapter + main.js) against captured page
// markup in a real DOM. Catches what unit tests cannot: the pieces not fitting together on a page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { fixture } from "./support/jsdom-provider.js";

const root = new URL("../", import.meta.url).pathname;
const source = (path) => readFileSync(root + path, "utf8");

async function bundledGlobals() {
  const result = await build({ entryPoints: [root + "src/entry/legacy-globals.js"], bundle: true, format: "iife", write: false, logLevel: "silent" });
  return result.outputFiles[0].text;
}

async function startOn(html) {
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn", (...args) => warnings.push(args.join(" ")));
  virtualConsole.on("jsdomError", (error) => warnings.push(String(error)));
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://chatgpt.com/c/test", pretendToBeVisual: true, virtualConsole });
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
  run(source("legacy/providers/chatgpt.js"), "chatgpt.js");
  run(source("legacy/main.js"), "main.js");
  await new Promise((resolve) => setTimeout(resolve, 1200)); // let the first camouflage sweep run
  return { window, document: window.document, warnings, count: (selector) => window.document.querySelectorAll(selector).length };
}

describe("content script on the 2026-10 ChatGPT layout", () => {
  test("hides the system prompt, replaces the command with a chip, and starts without warnings", async () => {
    const page = await startOn(fixture("chatgpt-search-units-2026-10.html"));
    try {
      assert.deepEqual(page.warnings, []);
      assert.ok(page.count(".zs-chip") >= 1, "a chip is drawn");
      assert.ok(page.document.querySelector('[data-code-block="true"]').classList.contains("zs-tool-hide"), "the JSON block is hidden");
      const user = page.document.querySelector('[data-content-search-unit-key$=":user"]');
      assert.ok(user.classList.contains("zs-hidden"), "the bootstrap prompt is camouflaged");
    } finally {
      page.window.close(); // stops the content script's timers even when an assertion failed
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
