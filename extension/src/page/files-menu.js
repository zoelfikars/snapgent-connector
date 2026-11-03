// SPDX-License-Identifier: GPL-3.0-or-later
// The "Files" pill of the bar: search the workspace's files, tick some, and tag them in the composer (see attachments.js).

import { fileRowsHtml, filesMenuHtml } from "../ui/index.js";
import { createPillMenu } from "./pill-menu.js";
import { MAX_TAGGED } from "./attachments.js";

/** @param {{ document: Document, root: HTMLElement, group: object, state: object, settings: object, files: object, toast: (text: string) => void }} deps */
export function createFilesMenu({ document, root, group, state, settings, files, toast }) {
  const button = root.querySelector("#zs-files-btn");
  const menu = root.querySelector("#zs-files-menu");
  const chosen = new Set();
  let paths = [];
  let query = "";

  const matching = () => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? paths.filter((path) => words.every((word) => path.toLowerCase().includes(word))) : paths;
  };
  const list = () => menu.querySelector(".zs-files-list");
  const redraw = () => {
    list().innerHTML = fileRowsHtml(matching(), chosen);
    menu.querySelector(".zs-files-count").textContent = chosen.size ? `${chosen.size} chosen` : "none chosen";
    menu.querySelector(".zs-files-insert").disabled = !chosen.size;
    root.querySelector("#zs-files-name").textContent = chosen.size ? `Files (${chosen.size})` : "Files";
  };

  const pill = createPillMenu({
    document, button, menu, group, width: 340, align: "right", roomAbove: 300,
    async render() {
      menu.innerHTML = filesMenuHtml();
      query = "";
      list().innerHTML = `<div class="zs-files-more">Loading files…</div>`;
      const search = menu.querySelector(".zs-files-search");
      // Typing here must not trigger the site's own keyboard shortcuts.
      for (const type of ["keydown", "keyup", "keypress"]) search.addEventListener(type, (event) => event.stopPropagation());
      search.addEventListener("input", () => { query = search.value; redraw(); });
      list().addEventListener("click", (event) => {
        const row = event.target.closest && event.target.closest(".zs-file-row");
        if (!row) return;
        const path = row.dataset.path;
        if (chosen.has(path)) chosen.delete(path);
        else if (chosen.size >= MAX_TAGGED) toast(`Up to ${MAX_TAGGED} files at a time.`);
        else chosen.add(path);
        redraw();
      });
      menu.querySelector(".zs-files-insert").addEventListener("click", async () => {
        try { await files.insert([...chosen]); } catch (error) { toast(String((error && error.message) || error)); return; }
        chosen.clear();
        redraw();
        pill.close();
      });
      const listing = await files.list();
      if (!listing.ok) { toast(listing.error); return false; }
      paths = listing.paths;
      redraw();
      search.focus();
    },
  });

  return {
    /** Shown only while a VS Code session is on: the files are read by the agent's own tool. */
    sync() {
      button.hidden = !(state.started && settings.target() === "vscode" && files.canList());
      if (button.hidden && pill.isOpen) pill.close();
    },
  };
}
