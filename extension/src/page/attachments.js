// SPDX-License-Identifier: GPL-3.0-or-later
// Tagging files in the message. The Files menu puts `@path` in the composer; when the user sends, the page holds the message back,
// reads the tagged files with `read_files` (the same text, line numbers and size limit the model would have got, and the same
// approval for a file that may hold secrets), and sends the message with the contents under it. That saves the model a turn
// that would only read them. The message is sent through the same path the agent's own messages use, so every site is handled the same.

import { findTags, tagText } from "../domain/prompt/file-tags.js";
import { feedbackIsError } from "../domain/tools/result-summary.js";
import { withoutResultHeader } from "../domain/tools/result-marker.js";
import { bareToolName } from "../domain/tools/names.js";

export const MAX_TAGGED = 20;
const LIST_TTL_MS = 30000;
const MIN_FILES_CHARS = 4000;
const MESSAGE_OVERHEAD = 200; // the line that introduces the files, and spacing

/** @param {{ provider: object, state: object, tools: object, chat: object, bar: object, budget: object, startTurn: (base: *) => void, diag: Function }} deps */
export function createAttachments({ provider, state, tools, chat, bar, budget, startTurn, diag }) {
  let files = null; // { paths: string[], known: Set<string>, at: number }
  const tagged = new Set();

  /** Every file of the workspace (relative paths), cached briefly. */
  async function listFiles() {
    if (files && Date.now() - files.at < LIST_TTL_MS) return { ok: true, paths: files.paths };
    const feedback = await tools.runner.run({ tool: "find_files", arguments: { path: "." } });
    let paths = null;
    try { paths = JSON.parse(withoutResultHeader(feedback)); } catch { /* an error text, not a list */ }
    if (!Array.isArray(paths)) return { ok: false, error: feedbackIsError(feedback) ? withoutResultHeader(feedback).split("\n")[0] : "The file list could not be read." };
    paths = paths.filter((path) => typeof path === "string").sort((a, b) => a.localeCompare(b));
    files = { paths, known: new Set(paths), at: Date.now() };
    return { ok: true, paths };
  }

  /** Tag each file at the end of what the user has typed. */
  async function insert(paths) {
    const current = (provider.editorText() || "").replace(/\s+$/, "");
    await provider.writeText(`${current ? `${current} ` : ""}${paths.map((path) => tagText(path).trim()).join(" ")} `);
    paths.forEach((path) => tagged.add(path));
  }

  /** Tag a file in place of the `@query` being typed from `start` on. */
  async function replaceTag(text, start, path) {
    await provider.writeText(text.slice(0, start) + tagText(path));
    tagged.add(path);
  }

  const isFile = (path) => tagged.has(path) || !!(files && files.known.has(path));

  /** The files this message tags: what the menus inserted, and any tag typed by hand that names a file of the workspace. */
  const referenced = (text) => findTags(text, isFile).slice(0, MAX_TAGGED);

  async function sendWithFiles(text, paths) {
    bar.cover(true);
    bar.coverLabel(`read_files · ${paths.length} file${paths.length > 1 ? "s" : ""}`);
    let handedOver = false;
    try {
      const room = Math.max(MIN_FILES_CHARS, budget.limit() - text.length - MESSAGE_OVERHEAD);
      const feedback = await tools.runner.run({ tool: "read_files", arguments: { paths } }, { budgetChars: room });
      if (feedbackIsError(feedback)) {
        // The message is still in the composer: nothing was lost, the user can fix it and send again.
        bar.banner("warn", "Could not attach the files", withoutResultHeader(feedback).split("\n").slice(0, 3).join(" "));
        return;
      }
      const message = `${text.trimEnd()}\n\nAttached files (their current contents, with line numbers; no need to read them again):\n${withoutResultHeader(feedback).trim()}`;
      handedOver = true; // the sender takes the flags from here
      const base = await chat.submit(message);
      paths.forEach((path) => tagged.delete(path));
      startTurn(base);
    } finally {
      bar.coverLabel("");
      if (!handedOver) { state.injecting = false; bar.cover(false); }
    }
  }

  /** Called when the user sends: true when the page takes the message over (the site must not send it). */
  function takeOver() {
    const text = provider.editorText() || "";
    const paths = referenced(text);
    if (!paths.length) return false;
    state.injecting = true; // a second Enter while the files are read must not send the bare message
    sendWithFiles(text, paths).catch((error) => {
      state.injecting = false;
      bar.cover(false);
      diag("attach.failed", { msg: String((error && error.message) || error) });
      bar.banner("warn", "Could not send the message", String((error && error.message) || error));
    });
    return true;
  }

  /** The tool the menu needs is advertised by this server. */
  const canList = () => tools.catalogue.active().some((tool) => bareToolName(tool.name) === "find_files");

  return { listFiles, insert, replaceTag, takeOver, canList };
}
