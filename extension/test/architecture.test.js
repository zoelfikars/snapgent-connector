import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".js") ? [path] : [];
  });
}

const importsOf = (code) => [...code.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);

// Which layers each layer may import from (besides itself). Dependencies point down.
const MAY_IMPORT = { domain: [], application: ["domain"], ui: ["domain"] };
const PURE = /\b(document|window|chrome|browser|localStorage|fetch|WebSocket|XMLHttpRequest|MutationObserver)\b\s*[.(\[]/;
// The UI layer draws, so it may use the DOM, but never talks to the browser's extension APIs or the network.
const NO_PLATFORM = /\b(chrome|browser|localStorage|fetch|WebSocket|XMLHttpRequest)\b\s*[.(\[]/;
const stripComments = (code) => code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("layering rules", () => {
  for (const layer of Object.keys(MAY_IMPORT)) {
    const root = join(SRC, layer);

    test(`${layer} ${layer === "ui" ? "uses no extension API or network" : "touches no DOM, browser API or I/O"}`, () => {
      for (const file of files(root)) {
        assert.doesNotMatch(stripComments(readFileSync(file, "utf8")), layer === "ui" ? NO_PLATFORM : PURE, relative(SRC, file));
      }
    });

    test(`${layer} only imports from ${["itself", ...MAY_IMPORT[layer]].join(" / ")}`, () => {
      const allowed = [layer, ...MAY_IMPORT[layer]].map((name) => join(SRC, name));
      for (const file of files(root)) {
        for (const spec of importsOf(readFileSync(file, "utf8"))) {
          const target = join(file, "..", spec);
          assert.ok(allowed.some((dir) => target.startsWith(dir)), `${relative(SRC, file)} imports ${spec}`);
        }
      }
    });

    test(`every ${layer} module stays small enough to hold in your head`, () => {
      for (const file of files(root)) {
        const lines = readFileSync(file, "utf8").split("\n").length;
        assert.ok(lines <= 250, `${relative(SRC, file)} has ${lines} lines`);
      }
    });
  }
});

// The page layer wires the other layers to this page: it may use the DOM and the extension APIs, and may import every layer below it,
// but nothing below it may import the page.
describe("page layer", () => {
  const root = join(SRC, "page");

  test("only imports from itself and the layers below it", () => {
    const allowed = ["page", "domain", "application", "ui", "infrastructure", "sites"].map((name) => join(SRC, name));
    for (const file of files(root)) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        assert.ok(allowed.some((dir) => join(file, "..", spec).startsWith(dir)), `${relative(SRC, file)} imports ${spec}`);
      }
    }
  });

  test("no other layer imports the page", () => {
    for (const layer of ["domain", "application", "ui", "infrastructure", "sites"]) {
      for (const file of files(join(SRC, layer))) {
        for (const spec of importsOf(readFileSync(file, "utf8"))) assert.ok(!join(file, "..", spec).startsWith(root), `${relative(SRC, file)} imports ${spec}`);
      }
    }
  });

  test("every page module stays small enough to hold in your head", () => {
    for (const file of files(root)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      assert.ok(lines <= 250, `${relative(SRC, file)} has ${lines} lines`);
    }
  });
});
