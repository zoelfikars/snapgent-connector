// SPDX-License-Identifier: GPL-3.0-or-later
// "MCP servers" popup: which servers are switched on. Only enabled servers appear in the target
// dropdown and are visible to the AI.

import { escapeHtml as esc } from "./html.js";
import { closeButton, mountPopup } from "./popup.js";

function row(option, enabled) {
  const meta = option.tools ? `${option.tools} tools` : "";
  return `<label class="zs-mcp-row"><span class="zs-mcp-row-info"><span class="zs-mcp-row-name">${esc(option.name)}</span><span class="zs-mcp-row-meta">${esc(meta)}</span></span><input type="checkbox" class="zs-mcp-check" data-id="${esc(option.id)}" ${enabled ? "checked" : ""}><span class="zs-mcp-toggle"></span></label>`;
}

/**
 * @param {{ document: Document,
 *           options: Array<{ id: string, name: string, tools?: number }>,
 *           isEnabled: (id: string) => boolean,
 *           setEnabled: (id: string, on: boolean) => void,
 *           onToggle?: () => void,   // after any switch, so the dropdown can refresh right away
 *           onClose?: () => void }} deps
 */
export function openMcpSettings({ document, options, isEnabled, setEnabled, onToggle = () => {}, onClose = () => {} }) {
  const { pop, close } = mountPopup(document, { onClose });
  pop.innerHTML =
    `<div class="zs-mcp-pop-card" role="dialog" aria-label="MCP settings">` +
      `<div class="zs-mcp-pop-head"><span>MCP servers</span>${closeButton}</div>` +
      `<div class="zs-mcp-pop-note">Only enabled servers appear in the dropdown and are read by the AI. Disabled servers cost no tokens.</div>` +
      `<div class="zs-mcp-pop-list">${options.map((option) => row(option, isEnabled(option.id))).join("")}</div>` +
    `</div>`;
  pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
  pop.querySelectorAll(".zs-mcp-check").forEach((box) =>
    box.addEventListener("change", () => {
      setEnabled(box.dataset.id, box.checked);
      onToggle();
    }));
  return { close };
}
