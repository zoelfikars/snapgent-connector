// SPDX-License-Identifier: GPL-3.0-or-later
// Tagging files and folders in the message. The Files menu puts `@path` (a folder: `@dir/`) in the composer; when the user sends, the
// page holds the message back, reads the tagged files (a folder is every text file under it) with `read_files` (the same text, line
// numbers and size limit the model would have got, and the same approval for a file that may hold secrets), and sends the message with
// the contents under it. That saves the model a turn that would only read them. What does not fit in one message goes in the next
// ones (PartQueue). The message is sent through the same path the agent's own messages use, so every site is handled the same.

import { findTags, foldersOf, isFolder, isTextFile, tagText } from "../domain/prompt/file-tags.js";
import { MAX_RESULT_PARTS } from "../domain/prompt/budget.js";
import { partMessages } from "../domain/prompt/parts.js";
import { feedbackIsError } from "../domain/tools/result-summary.js";
import { withoutResultHeader } from "../domain/tools/result-marker.js";
import { bareToolName } from "../domain/tools/names.js";

export const MAX_TAGGED = 20;        // tags in one message
const MAX_LISTED = 50000;            // the most files the list asks the server for
const MAX_FILES = 200;               // files in one message, folders included
const FILES_PER_CALL = 25;
const LIST_TTL_MS = 10000;
const MIN_FILES_CHARS = 4000;
const MESSAGE_OVERHEAD = 400;        // the line that introduces the files, and spacing

/** @param {{ provider: object, state: object, tools: object, chat: object, bar: object, budget: object, parts: object, preferences: object, startTurn: (base: *) => void, diag: Function }} deps */
export function createAttachments({ provider, state, tools, chat, bar, budget, parts, preferences, startTurn, diag }) {
  let files = null; // { paths: string[] (folders and files), known: Set<string>, files: string[], folders: Set<string>, at: number }
  const tagged = new Set();

  /** Every file and folder of the workspace (relative paths, a folder with its closing slash), cached briefly. */
  async function listFiles() {
    if (files && Date.now() - files.at < LIST_TTL_MS && files.at >= state.filesChangedAt) return { ok: true, paths: files.paths };
    const startedAt = Date.now();
    // The whole project (not the first 2000 files the model gets by default): every file must be taggable.
    const feedback = await tools.runner.run({ tool: "find_files", arguments: { path: ".", max_results: MAX_LISTED, exclude: preferences.excludedFolders(), exclude_only: true } });
    let paths = null;
    try { paths = JSON.parse(withoutResultHeader(feedback)); } catch { /* an error text, not a list */ }
    if (!Array.isArray(paths)) return { ok: false, error: feedbackIsError(feedback) ? withoutResultHeader(feedback).split("\n")[0] : "The file list could not be read." };
    const only = paths.filter((path) => typeof path === "string");
    const folders = foldersOf(only);
    paths = [...only, ...folders].sort((a, b) => a.localeCompare(b));
    files = { paths, known: new Set(paths), files: only, folders: new Set(folders), at: startedAt };
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

  /** A tag names a file, or a folder (`src/page/`, or `src/page` without the slash). */
  const folderOf = (tag) => (files ? [tag, `${tag}/`].find((name) => files.folders.has(name)) : (isFolder(tag) ? tag : null)) || null;
  const isEntry = (path) => tagged.has(path) || !!(files && (files.known.has(path) || files.folders.has(`${path}/`)));

  /** The tags of this message: what the menus inserted, and any tag typed by hand that names a file or a folder of the workspace. */
  const referenced = (text) => findTags(text, isEntry).slice(0, MAX_TAGGED);

  /** The files the tags stand for: a folder is every text file under it. */
  function expand(tags) {
    const found = new Set();
    for (const tag of tags) {
      const folder = folderOf(tag);
      if (!folder) found.add(tag);
      else if (files) files.files.filter((path) => path.startsWith(folder) && isTextFile(path)).forEach((path) => found.add(path));
    }
    const all = [...found];
    return { paths: all.slice(0, MAX_FILES), left: Math.max(0, all.length - MAX_FILES) };
  }

  /** Read the files in turns of a few at a time with `total` characters to spend; what has no room is named, not dropped silently. */
  async function readAll(paths, total) {
    const bodies = [];
    const unread = [];
    const queue = [...paths];
    let left = total;
    while (queue.length) {
      if (bodies.length && left < MIN_FILES_CHARS) { unread.push(...queue); break; }
      const group = queue.splice(0, FILES_PER_CALL);
      bar.coverLabel(`Running read_files · ${paths.length - queue.length - group.length + 1}-${paths.length - queue.length} of ${paths.length}`);
      const feedback = await tools.runner.run({ tool: "read_files", arguments: { paths: group } }, { budgetChars: Math.max(MIN_FILES_CHARS, left) });
      if (feedbackIsError(feedback)) return { error: withoutResultHeader(feedback).split("\n").slice(0, 3).join(" ") };
      const body = withoutResultHeader(feedback).replace(/\n?\.\.\. \[\d+ more files remaining:[\s\S]*\]\s*$/, "").trim();
      const missing = group.filter((path) => !body.includes(`===== ${path} =====`));
      if (missing.length === group.length) { unread.push(...group, ...queue); break; } // no room even for one
      bodies.push(body);
      left -= body.length;
      queue.unshift(...missing); // the server had no room for these in this turn: they go in the next
    }
    return { body: bodies.join("\n"), unread };
  }

  async function sendWithFiles(text, tags) {
    bar.cover(true);
    bar.coverLabel(`Running read_files · ${tags.length} tag${tags.length > 1 ? "s" : ""}`);
    let handedOver = false;
    try {
      const { paths, left } = expand(tags);
      // What does not fit in one message goes in the next ones, so the files may use all of them.
      const total = Math.max(MIN_FILES_CHARS, budget.limit() * MAX_RESULT_PARTS - text.length - MESSAGE_OVERHEAD);
      const read = await readAll(paths, total);
      if (read.error) {
        // The message is still in the composer: nothing was lost, the user can fix it and send again.
        bar.banner("warn", "Could not attach the files", read.error);
        return;
      }
      const notes = [];
      if (read.unread.length) notes.push(`Not attached, no room left: ${read.unread.join(", ")}`);
      if (left) notes.push(`Only the first ${MAX_FILES} files of the folders were attached (${left} more).`);
      const message = `${text.trimEnd()}\n\nAttached files (their current contents, with line numbers; no need to read them again):\n${read.body}${notes.length ? `\n\n${notes.join("\n")}` : ""}`;
      // With "Output as file" the message goes whole: the chat turns it into a file when it is over the size (page/output-file.js).
      const messages = budget.asFile && budget.asFile() ? [message] : partMessages(message, budget.limit(), MAX_RESULT_PARTS);
      if (messages.length > 1) parts.hold(messages);
      handedOver = true; // the sender takes the flags from here
      const base = await chat.submit(messages[0]);
      tags.forEach((tag) => tagged.delete(tag));
      startTurn(base);
    } finally {
      bar.coverLabel("");
      if (!handedOver) { state.injecting = false; bar.cover(false); }
    }
  }

  /** Called when the user sends: true when the page takes the message over (the site must not send it). */
  function takeOver() {
    const text = provider.editorText() || "";
    const tags = referenced(text);
    if (!tags.length) return false;
    state.injecting = true; // a second Enter while the files are read must not send the bare message
    sendWithFiles(text, tags).catch((error) => {
      state.injecting = false;
      bar.cover(false);
      diag("attach.failed", { msg: String((error && error.message) || error) });
      bar.banner("warn", "Could not send the message", String((error && error.message) || error));
    });
    return true;
  }

  /** The tool the menu needs is advertised by this server. */
  const canList = () => tools.catalogue.active().some((tool) => bareToolName(tool.name) === "find_files");

  /** Forget the cached listing and fetch it again: the Preferences may have just changed what is ignored. */
  async function refresh() { files = null; return listFiles(); }

  return { listFiles, refresh, insert, replaceTag, takeOver, canList };
}
