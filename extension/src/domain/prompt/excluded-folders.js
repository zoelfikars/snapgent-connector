// SPDX-License-Identifier: GPL-3.0-or-later
// Folders left out of the list of files and folders the user can attach (the `@` list and the Files menu). The user edits the list in
// the preferences; this is what it starts as. Names, not paths: a folder of that name is skipped wherever it is. Pure.

export const DEFAULT_EXCLUDED_FOLDERS = [
  "node_modules", "vendor", "target", "dist", "build", "out", "coverage", "__pycache__", ".venv", "venv", ".git", ".next", ".nuxt",
  ".svelte-kit", ".turbo", ".cache", ".idea", ".vscode", ".gradle", ".dart_tool", ".terraform", ".rustup", ".cargo", ".npm", ".yarn",
  ".pnpm-store", "Pods", "DerivedData", "site-packages", ".pytest_cache", ".mypy_cache", ".tox",
];

const MAX_NAMES = 300;
const MAX_NAME_LENGTH = 120;

/** What was typed (one name per line, or separated by commas) as a clean list: no slashes around the names, no empties, no repeats. */
export function parseFolderNames(text) {
  const names = [];
  for (const raw of String(text || "").split(/[\n,]/)) {
    const name = raw.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    if (name && name.length <= MAX_NAME_LENGTH && !names.includes(name)) names.push(name);
    if (names.length >= MAX_NAMES) break;
  }
  return names;
}

/** The saved setting, or the defaults when nothing usable is saved (an empty list is usable: the user may want nothing skipped). */
export function clampExcludedFolders(value) {
  return Array.isArray(value) ? parseFolderNames(value.filter((item) => typeof item === "string").join("\n")) : [...DEFAULT_EXCLUDED_FOLDERS];
}
