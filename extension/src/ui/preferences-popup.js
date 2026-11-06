// SPDX-License-Identifier: GPL-3.0-or-later
// The preferences panel: message size, commands per reply, the folders left out of the attachable files, and the project instruction
// files the agent reads at a start. Each change is saved as it is made. Opened from the menu behind the "switch AI" pill.

import { MAX_BATCH_CALLS, MAX_PROMPT_CHARS, MIN_BATCH_CALLS, MIN_PROMPT_CHARS } from "../domain/prompt/budget.js";
import { DEFAULT_CONTEXT_FILES } from "../domain/prompt/context-file.js";
import { parseFolderNames } from "../domain/prompt/excluded-folders.js";
import { escapeHtml as esc } from "./html.js";
import { closeButton, mountPopup } from "./popup.js";

const CHARS_STEP = 10000;
const BOX = "border:1px solid rgba(128,128,128,.4);border-radius:6px";
const MONO = "font:11px ui-monospace,Consolas,monospace";

const charsText = (chars) => `${Math.round(chars / 1000)}k chars (~${Math.round(chars / 4000)}k tokens)`;
const callsText = (count) => `${count} command${count === 1 ? "" : "s"}`;

const slider = (id, label, min, max, step, note) =>
  `<div class="zs-pref"><div style="display:flex;justify-content:space-between;gap:8px;font-weight:600"><span>${label}</span><span id="${id}-value"></span></div>` +
  `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" style="width:100%;box-sizing:border-box;margin:8px 0 2px" aria-label="${label}">` +
  `<div class="zs-mcp-pop-note">${note}</div></div>`;

/**
 * @param {{ document: Document,
 *           values: { chars: number, calls: number, folders: string[], contextFiles?: string[] },
 *           defaults: { folders: string[], contextFiles?: string[] },
 *           save: { chars: (value: number) => void, calls: (value: number) => void, folders: (list: string[]) => void, contextFiles?: (list: string[]) => void } }} deps
 */
export function openPreferences({ document, values, defaults, save, corner = "bottom", actions = {} }) {
  const contextFiles = values.contextFiles || [];
  const defaultContextFiles = defaults.contextFiles || DEFAULT_CONTEXT_FILES;
  const { pop, close } = mountPopup(document);
  const row = (id, title, note = "") =>
    `<button class="zs-site-opt" id="${id}" type="button"><span class="zs-site-name"><span>${title}</span>` +
    (note ? `<span class="zs-site-host">${note}</span>` : "") + `</span></button>`;
  const otherCorner = corner === "top" ? "bottom right" : "top right";
  const barSection = actions.onToggleCorner
    ? `<section class="zs-menu-sec"><div class="zs-sec-label"><span>This bar</span></div>` +
      row("zs-bar-corner", `Move to the ${otherCorner} corner`) +
      row("zs-bar-hide", "Hide the bar", "the small button in the corner shows it again") + `</section>`
    : "";
  const siteSection = actions.onCalibrate
    ? `<section class="zs-menu-sec"><div class="zs-sec-label"><span>This site</span></div>` +
      row("zs-cal-start", "Calibrate this site", "teach it where the text box, send button and replies are") +
      row("zs-cal-export", "Export calibration") + row("zs-cal-import", "Import calibration") +
      row("zs-cal-diag", "Copy diagnostics", "what it finds on this page, no text of the chat") +
      row("zs-cal-remove", "Remove calibration") + `</section>` +
      `<section class="zs-menu-sec"><div class="zs-sec-label"><span>All sites</span></div>` +
      row("zs-cal-export-all", "Export all calibrations", "one file, kept apart per AI") +
      row("zs-cal-import-all", "Import calibrations…", "choose which AIs to take from the files") + `</section>`
    : "";
  pop.innerHTML =
    `<div class="zs-mcp-pop-card" role="dialog" aria-label="Preferences"><div class="zs-mcp-pop-head"><span>Preferences</span>${closeButton}</div>` +
    `<div class="zs-mcp-pop-body">` +
    slider("zs-pref-chars", "Message size", MIN_PROMPT_CHARS, MAX_PROMPT_CHARS, CHARS_STEP,
      "The most one message to the chat may hold. Longer output goes in the next messages (up to 5), the rest is cut in the middle. About 4 characters per token.") +
    slider("zs-pref-calls", "Commands per reply", MIN_BATCH_CALLS, MAX_BATCH_CALLS, 1,
      "How many commands the AI may send in one reply. They run in order and are answered in one message; any beyond it are reported as not run.") +
    `<div class="zs-pref"><div style="font-weight:600">Folders left out of attachments</div>` +
    `<textarea id="zs-pref-folders" rows="7" spellcheck="false" style="width:100%;box-sizing:border-box;margin-top:8px;${MONO};background:transparent;color:inherit;${BOX};padding:6px" ` +
    `aria-label="Folders left out of attachments">${esc(values.folders.join("\n"))}</textarea>` +
    `<div class="zs-mcp-pop-note">One folder name per line (or separated by commas): a folder of that name is skipped wherever it is, in the <code>@</code> list and in the Files menu. ` +
    `In a git project the project's own <code>.gitignore</code> already applies on top.</div></div>` +
    `<div class="zs-pref"><div style="font-weight:600">Project instruction files</div>` +
    `<textarea id="zs-pref-context" rows="4" spellcheck="false" style="width:100%;box-sizing:border-box;margin-top:8px;${MONO};background:transparent;color:inherit;${BOX};padding:6px" ` +
    `aria-label="Project instruction files">${esc(contextFiles.join("\n"))}</textarea>` +
    `<div class="zs-mcp-pop-note">One file name per line. The first one found in the workspace is sent to the AI as project instructions when a session starts (usually <code>AGENTS.md</code>).</div></div>` +
    barSection + siteSection +
    `</div>` +
    `<div class="zs-mcp-pop-foot"><button id="zs-pref-reset" class="zs-mcp-pop-btn zs-mcp-pop-btn-block">Restore the defaults</button></div></div>`;
  pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);

  const bind = (id, value, show, store) => {
    const input = pop.querySelector(`#${id}`);
    const label = pop.querySelector(`#${id}-value`);
    input.value = String(value);
    label.textContent = show(value);
    input.addEventListener("input", () => { label.textContent = show(Number(input.value)); });
    input.addEventListener("change", () => store(Number(input.value)));
  };
  bind("zs-pref-chars", values.chars, charsText, save.chars);
  bind("zs-pref-calls", values.calls, callsText, save.calls);

  const folders = pop.querySelector("#zs-pref-folders");
  // Typing here must not trigger the site's own keyboard shortcuts.
  for (const type of ["keydown", "keyup", "keypress"]) folders.addEventListener(type, (event) => event.stopPropagation());
  folders.addEventListener("change", () => save.folders(parseFolderNames(folders.value)));

  const contextBox = pop.querySelector("#zs-pref-context");
  for (const type of ["keydown", "keyup", "keypress"]) contextBox.addEventListener(type, (event) => event.stopPropagation());
  contextBox.addEventListener("change", () => { if (save.contextFiles) save.contextFiles(contextBox.value.split("\n").map((s) => s.trim()).filter(Boolean)); });
  const action = (id, fn) => { const el = pop.querySelector(`#${id}`); if (el && fn) el.addEventListener("click", () => { close(); fn(); }); };
  action("zs-bar-corner", actions.onToggleCorner);
  action("zs-bar-hide", actions.onHideBar);
  action("zs-cal-start", actions.onCalibrate);
  action("zs-cal-export", actions.onExportCal);
  action("zs-cal-import", actions.onImportCal);
  action("zs-cal-diag", actions.onCopyDiag);
  action("zs-cal-remove", actions.onRemoveCal);
  action("zs-cal-export-all", actions.onExportAll);
  action("zs-cal-import-all", actions.onImportAll);
  pop.querySelector("#zs-pref-reset").addEventListener("click", () => {
    folders.value = defaults.folders.join("\n");
    save.folders(defaults.folders);
    if (save.contextFiles) {
      contextBox.value = defaultContextFiles.join("\n");
      save.contextFiles(defaultContextFiles);
    }
  });
}
