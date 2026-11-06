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
  { id: "plan", name: "Plan", note: "Read only; it may save its plan to .snapgent/plans/" },
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
  const auto = row("", "Auto", active ? `follows your editor: ${folderName(active)}` : "follows your active editor window", !pinned);
  const folders = open.map((path) => row(path, folderName(path), path, pinned === path)).join("");
  const typed = pinned && !open.includes(pinned) ? row(pinned, folderName(pinned), pinned, true) : "";
  return `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Workspace</span></div>${auto}</section>` +
    (folders || typed ? `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Open in your editor</span></div>${folders}${typed}</section>` : "") +
    `<section class="zs-menu-sec"><div class="zs-sec-label"><span>Another folder</span></div>` +
    `<button type="button" class="zs-site-opt zs-ws-pick"><span class="zs-site-name"><span>Choose a folder…</span><span class="zs-site-host">opens your system's folder window</span></span></button>` +
    // The typed path is only the way out when this machine has no folder window.
    `<form class="zs-ws-form" hidden><input class="zs-ws-input" type="text" spellcheck="false" autocomplete="off" placeholder="/full/path/to/folder" aria-label="Folder path">` +
    `<button type="submit" class="zs-ws-use">Use</button></form><div class="zs-ws-error" hidden></div></section>`;
}

/** The files window's body: a search box over the workspace's files, the list, the actions, and the folders left out. */
export const filesMenuHtml = () =>
  `<input class="zs-files-search" type="search" placeholder="Filter files..." autocomplete="off" spellcheck="false" aria-label="Search files">` +
  `<div class="zs-files-list"></div>` +
  `<div class="zs-files-foot"><span class="zs-files-count"></span>` +
  `<span class="zs-files-actions"><button type="button" class="zs-files-refresh" title="Fetch the list again" aria-label="Refresh the list">&#8635;</button>` +
  `<button type="button" class="zs-files-gear" title="Preferences: the folders left out" aria-label="Preferences">&#9881;</button>` +
  `<button type="button" class="zs-files-insert">Insert</button></span></div>` +
  `<div class="zs-files-ignored"><span class="zs-files-ignored-label"></span></div>` +
  `<label class="zs-files-toggle"><input type="checkbox" class="zs-files-at"> Open this list when I type @ in the message</label>`;

/**
 * The rows of a file list, the one markup behind both the Files menu and the popup beside the composer. With `chosen` (a Set) every row
 * has a tick and the chosen ones are marked; with `active` the row at that index is highlighted. At most `max` rows are drawn.
 */
export function fileRowsHtml(tree, { chosen = null, activePath = null, max = 200 } = {}) {
  const rows = [];
  let count = 0;
  function walk(node, depth) {
    const keys = Object.keys(node.children).sort((a, b) => {
      const aFolder = node.children[a].isFolder;
      const bFolder = node.children[b].isFolder;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const key of keys) {
      if (count >= max) return;
      const child = node.children[key];
      const on = chosen ? chosen.has(child.path) : child.path === activePath;
      const isFolder = child.isFolder;
      
      const indent = `<span class="zs-file-indent" style="width:${depth * 14}px"></span>`;
      const icon = isFolder
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;

      const caret = isFolder ? `<span class="zs-file-caret">${child.expanded ? "▼" : "▶"}</span>` : `<span class="zs-file-caret"></span>`;

      rows.push(`<div class="zs-file-row${isFolder ? " zs-file-folder" : ""}${chosen && on ? " zs-file-chosen" : ""}${child.path === activePath ? " zs-file-active" : ""}" data-path="${escapeHtml(child.path)}" role="option" aria-selected="${on}">` +
        `${chosen ? `<span class="zs-file-tick" data-path="${escapeHtml(child.path)}">${on ? "✓" : ""}</span>` : ""}` +
        `${indent}${caret}<span class="zs-file-icon">${icon}</span><span class="zs-file-path">${escapeHtml(child.name)}</span></div>`);
      count++;
      
      if (isFolder && child.expanded) {
        walk(child, depth + 1);
      }
    }
  }
  walk(tree, 0);
  if (count === 0) return `<div class="zs-files-more">No file matches</div>`;
  if (count >= max) rows.push(`<div class="zs-files-more">Showing first ${max} files…</div>`);
  return rows.join("");
}

/** The popup that opens beside the composer when the user types @: its header (with the ways to close it) and an empty list. */
export const atPopupHtml = () =>
  `<div class="zs-at-head"><span class="zs-at-title">Attach a file or folder</span>` +
  `<span class="zs-at-hint">↑↓ choose · Enter insert · Esc close</span>` +
  `<button type="button" class="zs-at-gear" title="Preferences: the folders left out" aria-label="Preferences">&#9881;</button>` +
  `<button type="button" class="zs-at-off" title="Stop opening this list when I type @">Turn off</button>` +
  `<button type="button" class="zs-at-x" aria-label="Close">✕</button></div><div class="zs-at-list"></div>` +
  `<div class="zs-at-ignored"><span class="zs-at-ignored-label"></span></div>`;

/** What the workspace pill shows. */
export const workspaceLabel = (pinned) => (pinned ? folderName(pinned) : "Auto");

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** The Switch AI pop-over: every supported site, the current one badged instead of linked. */
export function switchMenuHtml(sites, currentName) {
  const here = String(currentName || "").toLowerCase();
  const grid = sites.map((site) => {
    const label = `<span class="zs-site-name"><span>${escapeHtml(site.name)}</span><span class="zs-site-host">${escapeHtml(hostOf(site.url))}</span></span>`;
    return site.name.toLowerCase() === here
      ? `<div class="zs-site-opt zs-site-here">${label}<span class="zs-site-badge">active</span></div>`
      : `<button class="zs-site-opt" data-u="${escapeHtml(site.url)}">${label}<span class="zs-site-go">&rarr;</span></button>`;
  }).join("");
  return `<div class="zs-menu-head"><span class="zs-menu-logo">snapgentV3</span></div>
         <section class="zs-menu-sec">
           <div class="zs-sec-label"><span>Switch AI</span></div>
           <div class="zs-site-grid">${grid}</div>
         </section>`;
}
