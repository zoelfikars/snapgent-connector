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

describe("layering rules", () => {
  test("domain is pure: no DOM, no browser APIs, no I/O", () => {
    const forbidden = /\b(document|window|chrome|browser|localStorage|fetch|WebSocket|XMLHttpRequest|MutationObserver)\b\s*[.(\[]/;
    for (const file of files(join(SRC, "domain"))) {
      const code = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(code, forbidden, relative(SRC, file));
    }
  });

  test("domain only imports from domain", () => {
    for (const file of files(join(SRC, "domain"))) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        const target = join(file, "..", spec);
        assert.ok(target.startsWith(join(SRC, "domain")), `${relative(SRC, file)} imports ${spec}`);
      }
    }
  });

  test("every domain module stays small enough to hold in your head", () => {
    for (const file of files(join(SRC, "domain"))) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      assert.ok(lines <= 250, `${relative(SRC, file)} has ${lines} lines`);
    }
  });
});
