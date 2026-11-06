// SPDX-License-Identifier: GPL-3.0-or-later
// The files that may hold the project's own instructions to the agent (AGENTS.md and its siblings). The first one found is put into
// the start message, so the model knows the conventions before it is told what to do. Pure.

export const DEFAULT_CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** Keep the list to the names that are usable: one per line, no slashes, no repeats. */
export function clampContextFiles(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CONTEXT_FILES];
  const names = [];
  for (const raw of value) {
    const name = String(raw || "").trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    if (name && name.length <= 100 && !names.includes(name)) names.push(name);
    if (names.length >= 20) break;
  }
  return names;
}

/** The file as the model should read it: without the `read_files` wrapping (the `===== name =====` line and the line numbers).
 * Only an `@` that starts a word could be read as a file to attach (an address like a@b.com never is). One followed by a path
 * (`@docs/x.md`) loses its `@`, so the reference stays a plain path the model can read with `read_files`; any other (`@import`) becomes a plain word. */
export const cleanContext = (text) => String(text)
  .replace(/^=+ .+? =+\r?\n/, "") // the header of the one file that was read
  .replace(/^\d+: /gm, "") // the line numbers read_files puts in front of every line
  .replace(/(^|\s)@(?=[\w.~-]*(?:\/|\.\w))/gm, "$1")
  .replace(/(^|\s)@/gm, "$1[at]");
