// SPDX-License-Identifier: GPL-3.0-or-later
// Turns tutorial/<language>/tutorial.md and the images they name (`@gambar(file.png)`, found in tutorial/images/) into the module the
// extension imports. Images are embedded as data URIs, so the page never makes a request for them and the manifest needs nothing extra.
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { TUTORIAL_LANGUAGES } from "../src/domain/tutorial/language.js";
import { imageNames } from "../src/domain/tutorial/parse.js";

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const SAFE_NAME = /^\w[\w .-]*$/; // a plain file name: no folders, no ".."
const WARN_TOTAL_BYTES = 600 * 1024;

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

/** @returns {Promise<string>} the source of the module that replaces src/page/tutorial-content.js */
export async function tutorialModuleSource(root, warn = console.warn) {
  const dir = join(root, "tutorial");
  const texts = {};
  for (const lang of TUTORIAL_LANGUAGES) texts[lang] = await readOptional(join(dir, lang, "tutorial.md"));
  const images = {};
  let total = 0;
  // The images are shared by the languages: one file can be named in both texts and is embedded once.
  for (const name of new Set(Object.values(texts).flatMap(imageNames))) {
    const type = TYPES[extname(name).toLowerCase()];
    if (!SAFE_NAME.test(name) || !type) throw new Error(`tutorial.md: @gambar(${name}) must be a plain file name ending in ${Object.keys(TYPES).join(", ")}`);
    let bytes;
    try {
      bytes = await readFile(join(dir, "images", name));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`tutorial.md: @gambar(${name}) not found in tutorial/images/`);
      throw error;
    }
    total += bytes.length;
    images[name] = `data:${type};base64,${bytes.toString("base64")}`;
  }
  if (total > WARN_TOTAL_BYTES) warn(`tutorial images total ${Math.round(total / 1024)} KB; they are embedded in content.js, consider compressing them`);
  return `export const TUTORIAL_TEXTS = ${JSON.stringify(texts)};\nexport const TUTORIAL_IMAGES = ${JSON.stringify(images)};\n`;
}

/** esbuild plugin: serves the generated module in place of the empty one in src/page. */
export const tutorialPlugin = (root) => ({
  name: "tutorial",
  setup(build) {
    build.onLoad({ filter: /page[\\/]tutorial-content\.js$/ }, async () => ({ contents: await tutorialModuleSource(root), loader: "js" }));
  },
});
