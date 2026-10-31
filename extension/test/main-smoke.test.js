import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;
const read = (path) => readFileSync(root + path, "utf8");

// Same permissive stand-in used by providers-smoke: any property is another stand-in.
function permissive() {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : key === "length" ? 0 : permissive()),
    apply: () => permissive(),
    construct: () => permissive(),
    has: () => true,
  });
}

async function bundledGlobals() {
  const result = await build({
    entryPoints: [root + "src/entry/legacy-globals.js"], bundle: true, format: "iife", write: false, logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

describe("content script boot order: globals.js -> adapter -> main.js", () => {
  test("main.js initialises and wires the tool runner to the real bundle", async () => {
    const queued = [];
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
      // Never fire timers: we only care that initialisation completes.
      setTimeout: (fn) => { queued.push(fn); return queued.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      Date, Promise, Map, Set, WeakMap, WeakSet, URL, JSON, Math, Object, Array, String, Number, RegExp, Symbol, Error,
    };
    for (const name of ["document", "window", "location", "navigator", "MutationObserver", "ResizeObserver", "Element", "HTMLElement", "Node", "Event", "File", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback", "performance", "history", "localStorage", "sessionStorage", "HTMLTextAreaElement", "HTMLInputElement", "InputEvent", "KeyboardEvent", "DataTransfer"]) ctx[name] = permissive();
    const stored = {};
    ctx.chrome = {
      storage: { local: { get: (_k, cb) => cb && cb({}), set: (obj) => Object.assign(stored, obj) } },
      runtime: { sendMessage: (_msg, cb) => cb && cb({ ok: true }), onMessage: { addListener() {} }, lastError: null },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    vm.runInContext(await bundledGlobals(), ctx, { filename: "globals.js" });
    assert.equal(typeof ctx.ZSApp.ToolRunner, "function");
    vm.runInContext(read("legacy/providers/uncalibrated.js"), ctx, { filename: "uncalibrated.js" });
    // Throws on a ReferenceError (e.g. use-before-define of the catalogue or runner).
    vm.runInContext(read("legacy/main.js"), ctx, { filename: "main.js" });
    await new Promise((resolve) => setImmediate(resolve)); // let startup microtasks surface their errors
  });
});
