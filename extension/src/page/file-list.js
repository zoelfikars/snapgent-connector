// SPDX-License-Identifier: GPL-3.0-or-later
// The list of files that both the Files menu and the popup beside the composer show: the same rows, the same scrolling, the same
// "nothing matches". They differ in what a click means. With `chosen` (a Set) a list is a multiple choice, ticked rows kept
// by the caller; without it one row is highlighted (`move`, `activePath`) and a click picks it.

import { buildFileTree } from "../domain/prompt/file-tags.js";
import { fileRowsHtml } from "../ui/index.js";

/**
 * @param {{ element: HTMLElement, chosen?: Set<string>, max?: number, onPick: (path: string) => void }} options
 *   `element` is the container the rows are drawn into; `onPick(path)` is called when a row is clicked.
 */
export function createFileList({ element, chosen = null, max = 200, onPick }) {
  let tree = { children: {}, isFolder: true, expanded: true };
  let visiblePaths = [];
  let activePath = null;

  function redraw() {
    visiblePaths = [];
    function walk(node) {
      const keys = Object.keys(node.children).sort((a, b) => {
        const aF = node.children[a].isFolder;
        const bF = node.children[b].isFolder;
        if (aF !== bF) return aF ? -1 : 1;
        return a.localeCompare(b);
      });
      for (const key of keys) {
        const child = node.children[key];
        visiblePaths.push(child.path);
        if (child.isFolder && child.expanded) walk(child);
      }
    }
    walk(tree);

    if (!activePath || !visiblePaths.includes(activePath)) {
      activePath = visiblePaths[0] || null;
    }
    element.innerHTML = fileRowsHtml(tree, { chosen, activePath, max });
    const row = element.querySelector(".zs-file-active");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  element.addEventListener("click", (event) => {
    const tick = event.target.closest && event.target.closest(".zs-file-tick");
    if (tick && chosen) {
      event.stopPropagation();
      onPick(tick.dataset.path);
      return;
    }
    
    const row = event.target.closest && event.target.closest(".zs-file-row");
    if (!row) return;
    
    const path = row.dataset.path;
    const caret = event.target.closest && event.target.closest(".zs-file-caret");
    
    // The caret opens and closes a folder; a click anywhere else on the row picks the folder or file.
    if (path.endsWith("/") && caret) {
      const parts = path.slice(0, -1).split("/");
      let current = tree;
      for (let i = 0; i < parts.length; i++) {
        if (!current.children[parts[i]]) break;
        current = current.children[parts[i]];
      }
      if (current && current.isFolder) {
        current.expanded = !current.expanded;
        redraw();
        return;
      }
    }
    onPick(path);
  });

  return {
    /** Show these files (already filtered). A single-choice list starts on its first row. */
    set(next) {
      tree = buildFileTree(next);
      activePath = null;
      redraw();
    },
    /** Redraw after the caller changed what is chosen. */
    draw: redraw,
    /** Move the highlight, wrapping round. */
    move(delta) {
      if (chosen || !visiblePaths.length) return;
      let idx = visiblePaths.indexOf(activePath);
      if (idx === -1) idx = 0;
      idx = (idx + delta + visiblePaths.length) % visiblePaths.length;
      activePath = visiblePaths[idx];
      redraw();
    },
    activePath: () => (chosen ? null : activePath),
    count: () => visiblePaths.length,
    message(text) { element.innerHTML = `<div class="zs-files-more">${text}</div>`; },
  };
}
