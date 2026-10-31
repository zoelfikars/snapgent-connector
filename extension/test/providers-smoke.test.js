import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";
import * as parser from "../src/domain/parser/index.js";
import * as chat from "../src/infrastructure/chat/index.js";

const DIR = new URL("../legacy/providers/", import.meta.url);
const adapters = readdirSync(DIR).filter((f) => f.endsWith(".js") && !/-(cm|net)\.js$/.test(f));

// A stand-in for any browser global: every property read yields another stand-in,
// every call returns one. Enough to let an adapter's top-level initialisation run.
function permissive() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : key === "length" ? 0 : permissive()),
    apply: () => permissive(),
    construct: () => permissive(),
    has: () => true,
  });
}

function sandbox() {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Map, Set, WeakMap, WeakSet, URL, JSON, Math, Object, Array, String, Number, RegExp, Symbol, Error,
    ZSParse: parser,
    ZSChat: chat,
    ZS: {},
    ZSDomain: {},
  };
  for (const name of ["document", "window", "location", "chrome", "navigator", "MutationObserver", "ResizeObserver", "IntersectionObserver", "Element", "HTMLElement", "Node", "Event", "InputEvent", "KeyboardEvent", "File", "DataTransfer", "HTMLTextAreaElement", "HTMLInputElement", "getComputedStyle", "requestAnimationFrame", "fetch", "performance", "history", "localStorage", "sessionStorage"]) {
    ctx[name] = permissive();
  }
  return vm.createContext(ctx);
}

describe("every chat adapter initialises against the shared primitives", () => {
  for (const file of adapters) {
    test(file, () => {
      const ctx = sandbox();
      const provider = vm.runInContext(`${readFileSync(new URL(file, DIR), "utf8")}\n;ZSProvider`, ctx, { filename: file });
      assert.ok(provider && typeof provider === "object", "adapter did not export ZSProvider");
      for (const member of ["stopGeneration", "typeAndSend", "installSendHooks"]) {
        assert.equal(typeof provider[member], "function", `${file} is missing ${member}`);
      }
    });
  }
});
