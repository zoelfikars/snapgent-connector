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
const MAY_IMPORT = { domain: [], application: ["domain"] };
const PURE = /\b(document|window|chrome|browser|localStorage|fetch|WebSocket|XMLHttpRequest|MutationObserver)\b\s*[.(\[]/;
const stripComments = (code) => code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("layering rules", () => {
  for (const layer of Object.keys(MAY_IMPORT)) {
    const root = join(SRC, layer);

    test(`${layer} touches no DOM, browser API or I/O`, () => {
      for (const file of files(root)) {
        assert.doesNotMatch(stripComments(readFileSync(file, "utf8")), PURE, relative(SRC, file));
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
