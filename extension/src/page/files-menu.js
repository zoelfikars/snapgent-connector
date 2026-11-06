// SPDX-License-Identifier: GPL-3.0-or-later
// The Files window: search the workspace's files, tick some, and tag them in the composer (see attachments.js). A floating window
// (resize from the corner, move by its handle) so a long list can be worked through; the folders left out of attachments are shown
// at the bottom, with a way to fetch the list again and a gear that opens the Preferences.

import { matchPaths } from "../domain/prompt/file-tags.js";
import { createFloatingWindow, filesMenuHtml } from "../ui/index.js";
import { createFileList } from "./file-list.js";
import { MAX_TAGGED } from "./attachments.js";

/** @param {{ document: Document, root: HTMLElement, group: object, state: object, settings: object, files: object,
 *           preferences?: object, toast: (text: string) => void, openPreferences: () => void }} deps */
export function createFilesMenu({ document, root, group, state, settings, files, preferences, toast, openPreferences }) {
  const button = root.querySelector("#zs-files-btn");
  const win = createFloatingWindow({ document, title: "Files", className: "zs-files-win", width: 760 });
  win.body.innerHTML = filesMenuHtml();
  group.add({ close: () => win.close() });

  const $ = (selector) => win.body.querySelector(selector);
  const chosen = new Set();
  let paths = [];
  let query = "";
  let loading = false;

  const list = createFileList({ element: $(".zs-files-list"), chosen, onPick: toggle });

  function toggle(path) {
    if (chosen.has(path)) chosen.delete(path);
    else if (chosen.size >= MAX_TAGGED) toast(`Up to ${MAX_TAGGED} files at a time.`);
    else chosen.add(path);
    redraw();
  }

  function redraw() {
    list.set(matchPaths(paths, query));
    const count = $(".zs-files-count");
    count.textContent = chosen.size ? `${chosen.size} chosen` : "none chosen";
    count.classList.toggle("zs-files-clear", chosen.size > 0);
    count.title = chosen.size ? "Click to clear the selection" : "";
    $(".zs-files-insert").disabled = !chosen.size;
    showBadge();
  }

  function showBadge() {
    const badge = root.querySelector("#zs-files-badge");
    if (!badge) return;
    badge.hidden = chosen.size === 0;
    badge.textContent = chosen.size ? String(chosen.size) : "";
  }

  function showIgnored() {
    const label = $(".zs-files-ignored-label");
    if (!label) return;
    const names = preferences && preferences.excludedFolders ? preferences.excludedFolders() : [];
    label.textContent = names.length ? `Ignored: ${names.join(", ")}` : "Nothing is ignored";
  }

  async function load(force = false) {
    if (loading) return;
    loading = true;
    try {
      list.message("Loading files…");
      const listing = force && files.refresh ? await files.refresh() : await files.list();
      if (!listing.ok) { list.message(listing.error || "The files could not be listed."); return; }
      paths = listing.paths;
      redraw();
    } finally {
      loading = false;
    }
  }

  win.body.addEventListener("click", (event) => {
    if (event.target.closest(".zs-files-refresh")) load(true);
    else if (event.target.closest(".zs-files-gear")) { win.close(); openPreferences(); }
    else if (event.target.closest(".zs-files-clear")) { chosen.clear(); redraw(); }
  });

  const search = $(".zs-files-search");
  // Typing here must not trigger the site's own keyboard shortcuts.
  for (const type of ["keydown", "keyup", "keypress"]) search.addEventListener(type, (event) => event.stopPropagation());
  search.addEventListener("input", () => { query = search.value; redraw(); });

  const atToggle = $(".zs-files-at");
  atToggle.checked = settings.atPopup();
  atToggle.addEventListener("change", () => settings.setAtPopup(atToggle.checked));

  $(".zs-files-insert").addEventListener("click", async () => {
    try { await files.insert([...chosen]); } catch (error) { toast(String((error && error.message) || error)); return; }
    chosen.clear();
    redraw();
    win.close();
  });

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (win.isOpen()) { win.close(); return; }
    win.open();
    showIgnored();
    if (!paths.length) load();
    else redraw();
    search.focus();
  });

  showBadge();

  return {
    /** Shown only while a VS Code session is on: the files are read by the agent's own tool. */
    sync() {
      button.hidden = !(state.started && files.canList());
      if (button.hidden && win.isOpen()) win.close();
    },
  };
}
