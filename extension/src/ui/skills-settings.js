// SPDX-License-Identifier: GPL-3.0-or-later
// "Skills" popup: switch workspace skills on or off, and import skills (paste/file -> review -> save to
// the global library or install into the workspace). Three views: list, paste, review.

import { escapeHtml as esc } from "./html.js";
import { closeButton, mountPopup } from "./popup.js";

const WARN = "#ff6b6b";
const CAUTION = "#ffb454";
const MONO = "font:11px ui-monospace,Consolas,monospace";
const BOX = "border:1px solid rgba(128,128,128,.4);border-radius:6px";

const skillRow = (skill, enabled) =>
  `<label class="zs-mcp-row"><span class="zs-mcp-row-info"><span class="zs-mcp-row-name">${esc(skill.name)}</span><span class="zs-mcp-row-meta">${esc(skill.description)}</span></span><input type="checkbox" class="zs-mcp-check" data-name="${esc(skill.name)}" ${enabled ? "checked" : ""}><span class="zs-mcp-toggle"></span></label>`;

const globalRow = (name, description) =>
  `<div class="zs-mcp-row"><span class="zs-mcp-row-info"><span class="zs-mcp-row-name">${esc(name)}</span><span class="zs-mcp-row-meta">${esc(description)}</span></span><span class="zs-mcp-row-actions"><button class="zs-mcp-pop-btn zs-mcp-pop-btn-small zs-gskill-install" data-name="${esc(name)}">Install</button><button class="zs-mcp-pop-btn zs-mcp-pop-btn-small zs-gskill-del" data-name="${esc(name)}">Delete</button></span></div>`;

const shell = (title, label, body) =>
  `<div class="zs-mcp-pop-card" role="dialog" aria-label="${label}"><div class="zs-mcp-pop-head"><span>${title}</span>${closeButton}</div>${body}</div>`;

const actions = (...buttons) =>
  `<div class="zs-mcp-pop-foot">${buttons.map(([id, text]) => `<button id="${id}" class="zs-mcp-pop-btn">${text}</button>`).join("")}</div>`;

/**
 * @param {{ document: Document,
 *           skills: { all: Array<{name:string, description:string}>, globals: Record<string, {description:string, text:string}>,
 *                     validate: (text: string) => object, isEnabled: (name: string) => boolean, setEnabled: (name: string, on: boolean) => void,
 *                     saveGlobal: (text: string) => object, removeGlobal: (name: string) => void,
 *                     importText: (text: string) => Promise<object>, load: () => Promise<void> },
 *           maxFileBytes: number, loadOnOpen: boolean, FileReaderImpl?: typeof FileReader }} deps
 */
export function openSkillsSettings({ document, skills, maxFileBytes, loadOnOpen, FileReaderImpl = globalThis.FileReader }) {
  const { pop, close } = mountPopup(document);
  let mode = "list";
  let draft = "";
  let message = "";
  const on = (selector, handler) => { const el = pop.querySelector(selector); if (el) el.addEventListener("click", handler); };

  const toList = () => { mode = "list"; draft = ""; message = ""; render(); };

  function renderPaste() {
    pop.innerHTML = shell("Import skill", "Import skill",
      `<div class="zs-mcp-pop-body">` +
      `<input type="file" id="zs-skill-file" accept=".md,.txt,text/markdown,text/plain" style="font-size:11px;max-width:100%">` +
      `<textarea id="zs-skill-text" rows="10" style="width:100%;box-sizing:border-box;${MONO};background:transparent;color:inherit;${BOX};padding:6px" placeholder="Paste the full SKILL.md here (with --- name / description --- frontmatter)">${esc(draft)}</textarea>` +
      (message ? `<div class="zs-mcp-pop-note" style="color:${WARN}">${esc(message)}</div>` : "") +
      `</div>` + actions(["zs-skill-cancel", "Cancel"], ["zs-skill-review", "Review"]));
    pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
    const fileInput = pop.querySelector("#zs-skill-file");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > maxFileBytes) { message = "File too large (max 20 KB)."; renderPaste(); return; }
      const reader = new FileReaderImpl();
      reader.onload = () => { draft = String(reader.result || ""); message = ""; renderPaste(); };
      reader.onerror = () => { message = "Could not read the file."; renderPaste(); };
      reader.readAsText(file);
    });
    on("#zs-skill-cancel", toList);
    on("#zs-skill-review", () => {
      draft = pop.querySelector("#zs-skill-text").value;
      const checked = skills.validate(draft);
      if (!checked.ok) { message = checked.error; renderPaste(); return; }
      if (skills.all.some((skill) => skill.name === checked.name)) { message = `A skill named "${checked.name}" already exists.`; renderPaste(); return; }
      message = ""; mode = "review"; render();
    });
  }

  function renderReview() {
    const checked = skills.validate(draft);
    pop.innerHTML = shell("Import skill", "Import skill",
      `<div class="zs-mcp-pop-body">` +
      `<div class="zs-mcp-pop-note" style="color:${CAUTION}">Review carefully. Third-party skills can contain instructions that make the AI run commands or change files. It will be saved DISABLED until you turn it on.</div>` +
      `<div class="zs-mcp-pop-note"><b>${esc(checked.name || "")}</b> - ${esc(checked.description || "")}</div>` +
      `<pre style="max-height:220px;overflow:auto;white-space:pre-wrap;${MONO};${BOX};padding:6px">${esc(draft)}</pre>` +
      (message ? `<div class="zs-mcp-pop-note" style="color:${WARN}">${esc(message)}</div>` : "") +
      `</div>` +
      actions(["zs-skill-back", "Back"], ["zs-skill-global", "Save to global"], ["zs-skill-confirm", "Confirm import"]));
    pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
    on("#zs-skill-back", () => { mode = "paste"; message = ""; render(); });
    on("#zs-skill-global", () => {
      const result = skills.saveGlobal(draft);
      if (!result.ok) { message = result.error; renderReview(); return; }
      toList();
    });
    on("#zs-skill-confirm", async () => {
      const result = await skills.importText(draft);
      if (!result.ok) { message = result.error; renderReview(); return; }
      toList();
      await skills.load();
      if (pop.isConnected) render();
    });
  }

  function renderList() {
    const names = Object.keys(skills.globals);
    pop.innerHTML = shell("Skills", "Skills settings",
      `<div class="zs-mcp-pop-body">` +
      `<div class="zs-mcp-pop-note">Only enabled skills are listed in the prompt. Changes apply to the next chat session.</div>` +
      `<div class="zs-mcp-pop-list">${skills.all.length
        ? skills.all.map((skill) => skillRow(skill, skills.isEnabled(skill.name))).join("")
        : `<div class="zs-mcp-pop-note">No skills found in .snapgent/skills/ (workspace only).</div>`}</div>` +
      `<div class="zs-mcp-pop-note"><b>Global library</b> (stored in this browser; install into a workspace to use)</div>` +
      (names.length
        ? `<div>${names.map((name) => globalRow(name, skills.globals[name].description)).join("")}</div>`
        : `<div class="zs-mcp-pop-note">Empty. Use "Save to global" while reviewing an import.</div>`) +
      `</div>` +
      `<div class="zs-mcp-pop-foot"><button id="zs-skill-import" class="zs-mcp-pop-btn zs-mcp-pop-btn-block">+ Import skill</button></div>`);
    pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
    pop.querySelectorAll(".zs-gskill-install").forEach((button) => button.addEventListener("click", () => {
      const entry = skills.globals[button.dataset.name];
      if (!entry) return;
      draft = entry.text;
      message = skills.all.some((skill) => skill.name === button.dataset.name)
        ? `A skill named "${button.dataset.name}" already exists in this workspace.` : "";
      mode = "review"; render();
    }));
    pop.querySelectorAll(".zs-gskill-del").forEach((button) => button.addEventListener("click", () => {
      skills.removeGlobal(button.dataset.name); render();
    }));
    on("#zs-skill-import", () => { mode = "paste"; draft = ""; message = ""; render(); });
    pop.querySelectorAll(".zs-mcp-check").forEach((box) =>
      box.addEventListener("change", () => skills.setEnabled(box.dataset.name, box.checked)));
  }

  function render() {
    if (mode === "paste") renderPaste();
    else if (mode === "review") renderReview();
    else renderList();
  }

  render();
  if (loadOnOpen) skills.load().then(() => { if (pop.isConnected && mode === "list") render(); });
  return { close };
}
