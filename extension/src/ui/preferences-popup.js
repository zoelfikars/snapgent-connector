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
  // Only offered on a calibrated site (`values.site` is undefined otherwise); null means it has no values of its own yet.
  const siteBox = values.site !== undefined && save.site
    ? `<label class="zs-pref" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="zs-pref-site" style="margin-top:3px"><span><b>Only for this site</b>` +
      `<span class="zs-mcp-pop-note" style="display:block">Keep these two values in this AI's calibration: they go with Export calibration, and other sites keep the general values.</span></span></label>`
    : "";
  const asFileBox = `<label class="zs-pref" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="zs-pref-asfile" style="margin-top:3px"><span><b>Output as file</b>` +
    `<span class="zs-mcp-pop-note" style="display:block">A message longer than the message size is attached to the chat as a .txt file instead of being sent in parts (up to 5, the rest cut). Turn it on only for an AI that reads attached files.</span></span></label>`;
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
    `<div class="zs-mcp-pop-card zs-pref-card" role="dialog" aria-label="Preferences"><div class="zs-mcp-pop-head"><span>Preferences</span>${closeButton}</div>` +
    `<div class="zs-mcp-pop-body">` +
    slider("zs-pref-chars", "Message size", MIN_PROMPT_CHARS, MAX_PROMPT_CHARS, CHARS_STEP,
      "The most one message to the chat may hold. Longer output goes in the next messages (up to 5), the rest is cut in the middle. About 4 characters per token.") +
    slider("zs-pref-calls", "Commands per reply", MIN_BATCH_CALLS, MAX_BATCH_CALLS, 1,
      "How many commands the AI may send in one reply. They run in order and are answered in one message; any beyond it are reported as not run.") + asFileBox + siteBox +
    (actions.onCopyTest
      ? slider("zs-pref-lorem", "Test text size", MIN_PROMPT_CHARS, MAX_PROMPT_CHARS, CHARS_STEP,
        "Copies this many characters of lorem ipsum to the clipboard, to paste into the chat and see how much one message it accepts. Fill the text box writes it the way the extension writes its own messages, which a site may treat differently from a paste of your own. Nothing is saved.") +
        `<div class="zs-pref"><button id="zs-pref-lorem-copy" type="button" class="zs-mcp-pop-btn zs-mcp-pop-btn-block">Copy test text</button>` +
        (actions.onFillTest ? `<button id="zs-pref-lorem-fill" type="button" class="zs-mcp-pop-btn zs-mcp-pop-btn-block" style="margin-top:6px">Fill the text box</button>` : "") +
        (actions.onAttachTest ? `<select id="zs-pref-lorem-method" aria-label="How to attach the file" style="margin-top:6px;width:100%"><option value="paste">as a pasted file</option><option value="input">through the file input</option><option value="drop">as a dropped file</option></select><button id="zs-pref-lorem-file" type="button" class="zs-mcp-pop-btn zs-mcp-pop-btn-block" style="margin-top:6px">Fill the text box with a .txt file</button>` : "") + `</div>`
      : "") +
    (actions.onFillStartMessage
      ? `<div class="zs-pref"><div style="font-weight:600">Test the Start message</div>` +
        `<div class="zs-mcp-pop-note">Writes the exact message the Start button would send (instructions, commands, project tree) into the text box, without sending it or starting a session. Check it there, then press Start in a new chat to send it for real.</div>` +
        `<button id="zs-pref-start-fill" type="button" class="zs-mcp-pop-btn zs-mcp-pop-btn-block" style="margin-top:6px">Fill the text box with the start message</button></div>`
      : "") +
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
  // With "Only for this site" ticked the sliders write to this AI's calibration, otherwise to the general preferences.
  const own = values.site || null;
  let useSite = !!own;
  const general = { chars: values.chars, calls: values.calls, asFile: !!values.asFile };
  const sliderValue = (id) => Number(pop.querySelector(`#${id}`).value);
  const both = () => ({ chars: sliderValue("zs-pref-chars"), calls: sliderValue("zs-pref-calls"), asFile: pop.querySelector("#zs-pref-asfile").checked });
  bind("zs-pref-chars", own && own.chars ? own.chars : values.chars, charsText, (value) => { if (useSite) save.site(both()); else { general.chars = value; save.chars(value); } });
  bind("zs-pref-calls", own && own.calls ? own.calls : values.calls, callsText, (value) => { if (useSite) save.site(both()); else { general.calls = value; save.calls(value); } });
  const asFileTick = pop.querySelector("#zs-pref-asfile");
  asFileTick.checked = own && typeof own.asFile === "boolean" ? own.asFile : !!values.asFile;
  asFileTick.addEventListener("change", () => {
    if (useSite) { save.site(both()); return; }
    general.asFile = asFileTick.checked;
    if (save.asFile) save.asFile(asFileTick.checked);
  });
  const loremSize = pop.querySelector("#zs-pref-lorem");
  if (loremSize) {
    bind("zs-pref-lorem", 100000, charsText, () => {});
    pop.querySelector("#zs-pref-lorem-copy").addEventListener("click", () => actions.onCopyTest(Number(loremSize.value)));
    const attach = pop.querySelector("#zs-pref-lorem-file");
    if (attach) attach.addEventListener("click", () => { const size = Number(loremSize.value); const method = pop.querySelector("#zs-pref-lorem-method").value; close(); actions.onAttachTest(size, method); });
    const fill = pop.querySelector("#zs-pref-lorem-fill");
    if (fill) fill.addEventListener("click", () => { const size = Number(loremSize.value); close(); actions.onFillTest(size); });
  }
  const startFill = pop.querySelector("#zs-pref-start-fill");
  if (startFill) startFill.addEventListener("click", () => { close(); actions.onFillStartMessage(); });
  const siteTick = pop.querySelector("#zs-pref-site");
  if (siteTick) {
    siteTick.checked = useSite;
    siteTick.addEventListener("change", () => {
      useSite = siteTick.checked;
      if (useSite) { save.site(both()); return; }
      save.site(null);
      asFileTick.checked = general.asFile;
      for (const [id, value] of [["zs-pref-chars", general.chars], ["zs-pref-calls", general.calls]]) {
        const input = pop.querySelector(`#${id}`);
        input.value = String(value);
        input.dispatchEvent(new (document.defaultView.Event)("input"));
      }
    });
  }

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
