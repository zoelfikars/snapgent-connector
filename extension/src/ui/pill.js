// SPDX-License-Identifier: GPL-3.0-or-later
// The dropdown pill of the bar (MCP target, Switch AI): one component, so both look and behave the same.
import { escapeHtml } from "./html.js";

const ARROW = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

/**
 * @param {{ id: string, nameId: string, label: string, title?: string, popup?: string }} pill
 *   `nameId` is the span the page script fills with the current choice; `popup` is the aria-haspopup role.
 */
export const pillHtml = ({ id, nameId, label, title = "", popup = "menu" }) =>
  `<button type="button" class="zs-pill" id="${escapeHtml(id)}" aria-haspopup="${escapeHtml(popup)}" aria-label="${escapeHtml(label)}"${title ? ` title="${escapeHtml(title)}"` : ""}>` +
  `<span class="zs-pill-name" id="${escapeHtml(nameId)}"></span>${ARROW}</button>`;
