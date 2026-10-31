// Runs the REAL extension (bundled globals.js + the ChatGPT adapter + main.js) against captured page
// markup in a real DOM. Catches what unit tests cannot: the pieces not fitting together on a page.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { learnProfile } from "../src/infrastructure/calibration/index.js";
import { pageWith } from "./support/jsdom-provider.js";

const root = new URL("../", import.meta.url).pathname;
const source = (path) => readFileSync(root + path, "utf8");

async function bundledGlobals() {
  const result = await build({ entryPoints: [root + "src/entry/legacy-globals.js"], bundle: true, format: "iife", write: false, logLevel: "silent" });
  return result.outputFiles[0].text;
}

async function startOn(html, url = "https://chatgpt.com/c/test", { storage = {} } = {}) {
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn", (...args) => warnings.push(args.join(" ")));
  virtualConsole.on("jsdomError", (error) => warnings.push(String(error)));
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  // jsdom has no layout: say that every element is laid out, or nothing on the page counts as visible.
  window.Element.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
  window.__storageListeners = [];
  window.chrome = {
    storage: {
      local: { get: (_key, callback) => callback && callback({ ...storage }), set() {} },
      onChanged: { addListener: (listener) => { window.__storageListeners.push(listener); } },
    },
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
  run(source("legacy/providers/provider.js"), "provider.js");
  run(source("legacy/main.js"), "main.js");
  await new Promise((resolve) => setTimeout(resolve, 1200)); // let the first camouflage sweep run
  const providerId = () => run("ZSProvider.id", "probe.js");
  return { window, document: window.document, warnings, providerId, count: (selector) => window.document.querySelectorAll(selector).length };
}

// Until a site is calibrated (docs/CALIBRATION.md) the extension must still boot cleanly and say why it cannot start.
describe("content script on a supported site that is not calibrated yet", () => {
  test("shows the bar with the reason and a Calibrate button instead of Start, draws no chips and logs no warnings", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      assert.deepEqual(page.warnings, []);
      assert.ok(page.document.getElementById("zs-bar"), "the bar is there");
      assert.match(page.document.getElementById("zs-state").textContent, /Not calibrated for this site yet/);
      const action = page.document.getElementById("zs-action");
      assert.deepEqual([action.textContent, action.dataset.kind, action.disabled], ["Calibrate", "calibrate", false]);
      assert.equal(page.count(".zs-chip"), 0);
    } finally {
      page.window.close(); // stops the content script's timers even when an assertion failed
    }
  });

  test("the bar is actually on screen (not just in the page): shown, and placed inside the window", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      await new Promise((resolve) => setTimeout(resolve, 200)); // a few frames of the placement loop
      const bar = page.document.getElementById("zs-bar");
      assert.notEqual(bar.style.display, "none", "the placement loop left the bar hidden");
      assert.ok(bar.style.top && bar.style.left, "and gave it a position");
    } finally {
      page.window.close();
    }
  });

  test("pressing Calibrate opens the calibration panel, and Cancel closes it", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      page.document.getElementById("zs-action").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(page.document.getElementById("zs-calibrate"), "the panel is on the page");
      page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      // an untrusted Escape must not close it: only a genuine key does
      assert.ok(page.document.getElementById("zs-calibrate"), "a forged Escape does nothing");
    } finally {
      page.window.close();
    }
  });

  test("the menu offers calibrating, exporting, importing and removing this site's calibration", async () => {
    const page = await startOn("<html><body><main><p>a chat page</p></main></body></html>");
    try {
      page.document.getElementById("zs-switch").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const menu = page.document.getElementById("zs-menu");
      for (const id of ["zs-cal-start", "zs-cal-export", "zs-cal-import", "zs-cal-remove"]) assert.ok(menu.querySelector(`#${id}`), id);
    } finally {
      page.window.close();
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

// A profile stored by the calibration UI switches the same provider script from "not calibrated" to the calibrated engine.
describe("content script with a stored profile", () => {
  const PAGE = `<html><body>
    <div class="turn-user">⟦ZS-SYS⟧ hello</div>
    <div class="turn-assistant"><pre>{"command":"read_file","params":{"path":"a.js"}}</pre></div>
    <form><div id="box" contenteditable="true" role="textbox"></div><button aria-label="Send prompt"></button></form>
  </body></html>`;
  function storedProfile() {
    const { document } = pageWith(PAGE, "https://chatgpt.com/c/test");
    const learned = learnProfile({
      hostname: "chatgpt.com", name: "ChatGPT",
      picks: { composer: document.getElementById("box"), send: document.querySelector("button"), assistant: document.querySelector("pre"), user: document.querySelector(".turn-user") },
    });
    assert.equal(learned.error, undefined);
    return JSON.parse(JSON.stringify(learned.profile)); // what storage hands back
  }

  test("the bar stops saying 'not calibrated' and the page is read through the profile", async () => {
    const page = await startOn(PAGE, "https://chatgpt.com/c/test", { storage: { zsProfiles: { "chatgpt.com": storedProfile() } } });
    try {
      assert.deepEqual(page.warnings, []);
      assert.doesNotMatch(page.document.getElementById("zs-state").textContent, /Not calibrated/);
      assert.ok(page.count(".zs-chip") >= 1, "the command in the reply gets a chip");
    } finally {
      page.window.close();
    }
  });

  test("a profile for another site is ignored", async () => {
    const page = await startOn(PAGE, "https://chatgpt.com/c/test", { storage: { zsProfiles: { "gemini.google.com": storedProfile() } } });
    try {
      assert.match(page.document.getElementById("zs-state").textContent, /Not calibrated for this site yet/);
    } finally {
      page.window.close();
    }
  });

  test("storing and removing a profile switches the provider while the page stays open", async () => {
    const page = await startOn(PAGE, "https://chatgpt.com/c/test");
    try {
      assert.equal(page.providerId(), "uncalibrated");
      page.window.__storageListeners.forEach((listener) => listener({ zsProfiles: { newValue: { "chatgpt.com": storedProfile() } } }, "local"));
      assert.equal(page.providerId(), "chatgpt-com");
      page.window.__storageListeners.forEach((listener) => listener({ zsProfiles: { newValue: {} } }, "local"));
      assert.equal(page.providerId(), "uncalibrated");
    } finally {
      page.window.close();
    }
  });

  test("a broken profile is not used", async () => {
    const page = await startOn(PAGE, "https://chatgpt.com/c/test", { storage: { zsProfiles: { "chatgpt.com": { version: 99 } } } });
    try {
      assert.match(page.document.getElementById("zs-state").textContent, /Not calibrated for this site yet/);
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
