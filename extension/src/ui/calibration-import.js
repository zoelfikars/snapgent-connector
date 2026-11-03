// SPDX-License-Identifier: GPL-3.0-or-later
// "Import calibrations" popup: what the chosen files hold, one row per AI of the "switch AI" list, each with its own tick, so only some of
// them can be taken. A row says when the AI is already calibrated and the import would replace that.

import { escapeHtml as esc } from "./html.js";
import { closeButton, mountPopup } from "./popup.js";

function row(group) {
  const meta = `${group.profiles.length} site${group.profiles.length > 1 ? "s" : ""}${group.replaces ? " · replaces its current calibration" : ""}`;
  return `<label class="zs-mcp-row"><span class="zs-mcp-row-info"><span class="zs-mcp-row-name">${esc(group.name)}</span><span class="zs-mcp-row-meta">${esc(meta)}</span></span>` +
    `<input type="checkbox" class="zs-mcp-check" data-id="${esc(group.id)}" checked><span class="zs-mcp-toggle"></span></label>`;
}

/**
 * @param {{ document: Document, groups: { id: string, name: string, profiles: object[], replaces: boolean }[], skipped?: string[],
 *           onImport: (ids: string[]) => void }} deps  `onImport` gets the ids of the AIs left ticked
 */
export function openCalibrationImport({ document, groups, skipped = [], onImport }) {
  const { pop, close } = mountPopup(document);
  pop.innerHTML =
    `<div class="zs-mcp-pop-card" role="dialog" aria-label="Import calibrations">` +
      `<div class="zs-mcp-pop-head"><span>Import calibrations</span>${closeButton}</div>` +
      `<div class="zs-mcp-pop-note">Untick the AIs you do not want. An AI you already calibrated is replaced.${skipped.length ? ` Left out: ${esc(skipped.join("; "))}.` : ""}</div>` +
      `<div class="zs-mcp-pop-list">${groups.map(row).join("") || `<div class="zs-mcp-pop-note">Nothing usable in those files.</div>`}</div>` +
      `<div class="zs-cal-import-foot"><button type="button" class="zs-cal-import-go"${groups.length ? "" : " disabled"}>Import</button></div>` +
    `</div>`;
  pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
  pop.querySelector(".zs-cal-import-go").addEventListener("click", () => {
    onImport([...pop.querySelectorAll(".zs-mcp-check")].filter((box) => box.checked).map((box) => box.dataset.id));
    close();
  });
  return { close };
}
