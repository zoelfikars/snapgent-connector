// SPDX-License-Identifier: GPL-3.0-or-later
// Usage: node build/build.mjs [chrome|firefox|all]   ->  dist/<target>/
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, buildManifest } from "./manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const base = JSON.parse(await readFile(join(root, "manifests/base.json"), "utf8"));

const arg = process.argv[2] || "all";
const targets = arg === "all" ? TARGETS : [arg];

for (const target of targets) {
  const out = join(root, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await build({
    entryPoints: {
      globals: join(root, "src/entry/legacy-globals.js"),
      background: join(root, "src/entry/background.js"),
      popup: join(root, "src/entry/popup.js"),
    },
    outdir: out,
    bundle: true,
    format: "iife",
    target: ["chrome110", "firefox128"],
    legalComments: "none",
    logLevel: "warning",
  });

  await cp(join(root, "static"), out, { recursive: true });
  await cp(join(root, "legacy/main.js"), join(out, "main.js"));
  await cp(join(root, "legacy/providers"), join(out, "providers"), { recursive: true });

  const manifest = buildManifest(base, { target, version: pkg.version });
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built dist/${target} (v${pkg.version})`);
}
