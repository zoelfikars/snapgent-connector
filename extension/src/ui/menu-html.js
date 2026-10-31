// SPDX-License-Identifier: GPL-3.0-or-later
// The markup of the bar's two pop-over menus (MCP target, Switch AI). Pure string builders: every value that
// comes from a server name or a site list is escaped here, in one place, instead of inline in the page script.
import { escapeHtml } from "./html.js";

/** The <option> list behind the target dropdown. */
export const targetOptionsHtml = (options) =>
  options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join("");

/** The MCP target pop-over: one row per option, the active one badged. */
export function targetMenuHtml(options, currentId) {
  const rows = options.map((option) => {
    const current = option.id === currentId;
    return `<button type="button" class="zs-site-opt zs-target-opt${current ? " zs-target-cur" : ""}" data-id="${escapeHtml(option.id)}">` +
      `<span class="zs-site-name"><span>${escapeHtml(option.name)}</span></span>${current ? `<span class="zs-site-badge">active</span>` : ""}</button>`;
  }).join("");
  return `<section class="zs-menu-sec"><div class="zs-sec-label"><span>MCP target</span></div>${rows}</section>`;
}

const CALIBRATION_SECTION = `
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>This site</span></div>
           <button class="zs-site-opt" id="zs-cal-start" type="button"><span class="zs-site-name"><span>Calibrate this site</span><span class="zs-site-host">teach it where the text box, send button and replies are</span></span></button>
           <button class="zs-site-opt" id="zs-cal-export" type="button"><span class="zs-site-name"><span>Export calibration</span></span></button>
           <button class="zs-site-opt" id="zs-cal-import" type="button"><span class="zs-site-name"><span>Import calibration</span></span></button>
           <button class="zs-site-opt" id="zs-cal-diag" type="button"><span class="zs-site-name"><span>Copy diagnostics</span><span class="zs-site-host">what it finds on this page, no text of the chat</span></span></button>
           <button class="zs-site-opt" id="zs-cal-remove" type="button"><span class="zs-site-name"><span>Remove calibration</span></span></button>
         </section>`;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** The Switch AI pop-over: every supported site, the current one badged instead of linked. */
export function switchMenuHtml(sites, currentName, { calibration = false } = {}) {
  const here = String(currentName || "").toLowerCase();
  const grid = sites.map((site) => {
    const label = `<span class="zs-site-name"><span>${escapeHtml(site.name)}</span><span class="zs-site-host">${escapeHtml(hostOf(site.url))}</span></span>`;
    return site.name.toLowerCase() === here
      ? `<div class="zs-site-opt zs-site-here">${label}<span class="zs-site-badge">active</span></div>`
      : `<button class="zs-site-opt" data-u="${escapeHtml(site.url)}">${label}<span class="zs-site-go">&rarr;</span></button>`;
  }).join("");
  return `<div class="zs-menu-head"><span class="zs-menu-logo">snapgentV3</span></div>
         <section class="zs-menu-sec">
           <div class="zs-sec-label zs-sec-label-row"><span>Switch AI</span><span><button id="zs-skills-settings" class="zs-gear" title="Skills" aria-label="Skills">&#9733;</button><button id="zs-mcp-settings" class="zs-gear" title="MCP settings" aria-label="MCP settings">&#9881;</button></span></div>
           <div class="zs-site-grid">${grid}</div>
         </section>${calibration ? CALIBRATION_SECTION : ""}`;
}
