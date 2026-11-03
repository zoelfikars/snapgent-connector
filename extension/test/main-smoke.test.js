import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const root = new URL("../", import.meta.url).pathname;

// The calibrations shipped in profiles/ are the maintainer's to change; these tests must not depend on which sites they cover.
const withoutShippedCalibrations = (base) => ({
  name: "no-shipped-calibrations",
  setup: (b) => b.onResolve({ filter: /default-calibrations\.json$/ }, () => ({ path: base + "test/fixtures/no-default-calibrations.json" })),
});

// Same permissive stand-in used by providers-smoke: any property is another stand-in.
function permissive() {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : key === "length" ? 0 : permissive()),
    apply: () => permissive(),
    construct: () => permissive(),
    has: () => true,
  });
}

async function bundledContentScript() {
  const result = await build({ entryPoints: [root + "src/entry/content.js"], bundle: true, format: "iife", write: false, logLevel: "silent", plugins: [withoutShippedCalibrations(root)] });
  return result.outputFiles[0].text;
}

describe("content script boot", () => {
  test("the bundle initialises and wires every part together", async () => {
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

    // Throws on a ReferenceError (a part used before it is made) or a missing export.
    vm.runInContext(await bundledContentScript(), ctx, { filename: "content.js" });
    await new Promise((resolve) => setImmediate(resolve)); // let startup microtasks surface their errors
  });
});
