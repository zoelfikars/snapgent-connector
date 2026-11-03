// SPDX-License-Identifier: GPL-3.0-or-later
// The list of files that both the Files menu and the popup beside the composer show: the same rows, the same scrolling, the same
// "nothing matches". They differ in what a click means. With `chosen` (a Set) a list is a multiple choice, ticked rows kept
// by the caller; without it one row is highlighted (`move`, `activePath`) and a click picks it.

import { fileRowsHtml } from "../ui/index.js";

/**
 * @param {{ element: HTMLElement, chosen?: Set<string>, max?: number, onPick: (path: string) => void }} options
 *   `element` is the container the rows are drawn into; `onPick(path)` is called when a row is clicked.
 */
export function createFileList({ element, chosen = null, max = 200, onPick }) {
  let paths = [];
  let active = chosen ? -1 : 0;

  function draw() {
    element.innerHTML = fileRowsHtml(paths, { chosen, active, max });
    const row = element.querySelector(".zs-file-active");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  element.addEventListener("click", (event) => {
    const row = event.target.closest && event.target.closest(".zs-file-row");
    if (row) onPick(row.dataset.path);
  });

  return {
    /** Show these files (already filtered). A single-choice list starts on its first row. */
    set(next) { paths = next; active = chosen ? -1 : 0; draw(); },
    /** Redraw after the caller changed what is chosen. */
    draw,
    /** Move the highlight, wrapping round. */
    move(delta) {
      const rows = Math.min(paths.length, max);
      if (!rows || chosen) return;
      active = (active + delta + rows) % rows;
      draw();
    },
    activePath: () => (chosen ? null : paths[active] || null),
    count: () => paths.length,
    message(text) { element.innerHTML = `<div class="zs-files-more">${text}</div>`; },
  };
}
