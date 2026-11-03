// SPDX-License-Identifier: GPL-3.0-or-later
// The markup of the bar's pop-over menus (MCP target, approval mode, workspace, Switch AI). Pure string builders: every value that
// comes from a server name or a site list is escaped here, in one place, instead of inline in the page script.
import { escapeHtml } from "./html.js";

/** The MCP target pop-over: one row per option, the active one badged. */
export function targetMenuHtml(options, currentId) {
  const rows = options.map((option) => {
    const current = option.id === currentId;
    return `<button type="button" class="zs-site-opt zs-target-opt${current ? " zs-target-cur" : ""}" data-id="${escapeHtml(option.id)}">` +
      `<span class="zs-site-name"><span>${escapeHtml(option.name)}</span></span>${current ? `<span class="zs-site-badge">active</span>` : ""}</button>`;
  }).join("");
  return `<section class="zs-menu-sec"><div class="zs-sec-label"><span>MCP target</span></div>${rows}</section>`;
}

/** What the bar offers for approvals; `id` is what the VS Code server understands (see server/snapgent_vscode/security/modes.py). */
export const APPROVAL_MODES = [
  { id: "plan", name: "Plan", note: "Read only: it can look around but changes nothing" },
  { id: "manual", name: "Manual", note: "Asks before deleting, committing or running commands" },
  { id: "auto", name: "Auto", note: "Does everything without asking" },
];

/** The approval-mode pop-over: one row per mode, the active one badged. */
export function modeMenuHtml(currentId) {
  const rows = APPROVAL_MODES.map((mode) => {
    const current = mode.id === currentId;
    return `<button type="button" class="zs-site-opt zs-mode-opt${current ? " zs-target-cur" : ""}" data-id="${mode.id}">` +
      `<span class="zs-site-name"><span>${mode.name}</span><span class="zs-site-host">${escapeHtml(mode.note)}</span></span>${current ? `<span class="zs-site-badge">active</span>` : ""}</button>`;
  }).join("");
  return `<section class="zs-menu-sec"><div class="zs-sec-label"><span>When it needs approval</span></div>${rows}</section>`;
}

const folderName = (path) => String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(path);

/**
 * The workspace pop-over: follow VS Code's active window (Auto), one of the folders VS Code has open, or any folder typed in.
 * @param {{ active: string|null, open: string[], pinned: string|null }} state
 */
export function workspaceMenuHtml({ active, open, pinned }) {
  const row = (path, title, note, current) =>
    `<button type="button" class="zs-site-opt zs-ws-opt${current ? " zs-target-cur" : ""}" data-path="${escapeHtml(path)}">` +
    `<span class="zs-site-name"><span>${escapeHtml(title)}</span><span class="zs-site-host">${escapeHtml(note)}</span></span>${current ? `<span class="zs-site-badge">in use</span>` : ""}</button>`;
  const auto = row("", "Auto", active ? `follows VS Code: ${folderName(active)}` : "follows the active VS Code window", !pinned);
  const folders = open.map((path) => row(path, folderName(path), path, pinned === path)).join("");
  const typed = pinned && !open.includes(pinned) ? row(pinned, folderName(pinned), pinned, true) : "";
  return `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Workspace</span></div>${auto}</section>` +
    (folders || typed ? `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Open in VS Code</span></div>${folders}${typed}</section>` : "") +
    `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Another folder</span></div>` +
    `<button type="button" class="zs-site-opt zs-ws-pick"><span class="zs-site-name"><span>Choose a folder…</span><span class="zs-site-host">opens your system's folder window</span></span></button>` +
    // The typed path is only the way out when this machine has no folder window.
    `<form class="zs-ws-form" hidden><input class="zs-ws-input" type="text" spellcheck="false" autocomplete="off" placeholder="/full/path/to/folder" aria-label="Folder path">` +
    `<button type="submit" class="zs-ws-use">Use</button></form><div class="zs-ws-error" hidden></div></section>`;
}

/** What the workspace pill shows. */
export const workspaceLabel = (pinned) => (pinned ? folderName(pinned) : "Auto");

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
export function switchMenuHtml(sites, currentName, { calibration = false, corner = "bottom" } = {}) {
  const other = corner === "top" ? "bottom right" : "top right";
  const barSection = `
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>This bar</span></div>
           <button class="zs-site-opt" id="zs-bar-corner" type="button"><span class="zs-site-name"><span>Move to the ${other} corner</span></span></button>
           <button class="zs-site-opt" id="zs-bar-hide" type="button"><span class="zs-site-name"><span>Hide the bar</span><span class="zs-site-host">the small button in the corner shows it again</span></span></button>
         </section>`;
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
         </section>${barSection}${calibration ? CALIBRATION_SECTION : ""}`;
}
