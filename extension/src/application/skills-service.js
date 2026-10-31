// SPDX-License-Identifier: GPL-3.0-or-later
// Skills available to the model: those found in the workspace (with a per-skill
// on/off toggle) and a global library kept in extension storage. Skill bodies are
// read by the model on demand (progressive disclosure); only name + description
// go into the prompt.

import { MAX_SKILLS_LOADED, SKILLS_DIR, parseSkillHeader, skillPath, validateSkillText } from "../domain/skills/skill-text.js";

const ENABLED_KEY = "zsSkillsEnabled";
const GLOBAL_KEY = "zsGlobalSkills";
const CALL_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 8000;

const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export class SkillsService {
  /**
   * @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: object) => void },
   *           findTool: (bareName: string) => ({ name: string } | undefined),
   *           callTool: (name: string, args: object, timeoutMs: number) => Promise<{ ok?: boolean, text?: string, error?: string }>,
   *           diag?: (event: string, data?: object) => void, log?: (...args: unknown[]) => void }} deps
   */
  constructor({ store, findTool, callTool, diag = () => {}, log = () => {} }) {
    Object.assign(this, { _store: store, _findTool: findTool, _callTool: callTool, _diag: diag, _log: log });
    this._all = [];          // every skill on disk, enabled or not
    this._enabledMap = {};   // { name: boolean }; never toggled counts as enabled
    this._globals = {};      // { name: { description, text } }
    /** Resolves once persisted toggles and the global library are loaded. */
    this.ready = Promise.all([this._hydrate(ENABLED_KEY, (v) => { this._enabledMap = v; }), this._hydrate(GLOBAL_KEY, (v) => { this._globals = v; })]);
  }

  async _hydrate(key, assign) {
    try {
      const saved = await this._store.get(key);
      if (isPlainObject(saved)) assign(saved);
    } catch (error) {
      this._log(`Could not load ${key}:`, error);
    }
  }

  get all() { return this._all; }
  get enabled() { return this._all.filter((skill) => this.isEnabled(skill.name)); }
  get globals() { return this._globals; }
  validate(text) { return validateSkillText(text); }

  isEnabled(name) { return this._enabledMap[name] !== false; }

  setEnabled(name, on) {
    this._enabledMap = { ...this._enabledMap, [name]: !!on };
    this._persist(ENABLED_KEY, this._enabledMap);
  }

  /** Scan the workspace for SKILL.md files. Never throws; on any problem the list stays empty. */
  async load() {
    this._all = [];
    try {
      const find = this._findTool("find_files");
      const read = this._findTool("read_file");
      if (!find || !read) return;
      const found = await this._callTool(find.name, { path: SKILLS_DIR, pattern: "**/SKILL.md" }, CALL_TIMEOUT_MS);
      if (!found || !found.ok || !found.text) return;
      let paths;
      try { paths = JSON.parse(found.text); } catch { return; }
      if (!Array.isArray(paths)) return;
      const skills = [];
      for (const path of paths.slice(0, MAX_SKILLS_LOADED)) {
        if (typeof path !== "string") continue;
        const file = await this._callTool(read.name, { path }, CALL_TIMEOUT_MS);
        if (!file || !file.ok || !file.text) continue;
        const header = parseSkillHeader(file.text);
        if (header) skills.push({ ...header, path });
      }
      this._all = skills;
      this._diag("skills.loaded", { count: skills.length, enabled: this.enabled.length });
    } catch (error) {
      this._log("Could not load workspace skills:", error);
    }
  }

  /** Write a validated skill into the workspace. create_file never overwrites. Imported skills start DISABLED. */
  async importText(text) {
    const checked = validateSkillText(text);
    if (!checked.ok) return checked;
    const create = this._findTool("create_file");
    if (!create) return { ok: false, error: "create_file is not available on this server." };
    if (this._all.some((skill) => skill.name === checked.name)) return { ok: false, error: `A skill named "${checked.name}" already exists.` };
    const result = await this._callTool(create.name, { path: skillPath(checked.name), content: text }, WRITE_TIMEOUT_MS);
    if (!result || !result.ok) return { ok: false, error: (result && (result.error || result.text)) || "Write failed." };
    this.setEnabled(checked.name, false);
    return { ok: true, name: checked.name };
  }

  /** The global library lives in extension storage; the model cannot read it until a skill is imported. */
  saveGlobal(text) {
    const checked = validateSkillText(text);
    if (!checked.ok) return checked;
    if (this._globals[checked.name]) return { ok: false, error: `A global skill named "${checked.name}" already exists.` };
    this._globals = { ...this._globals, [checked.name]: { description: checked.description, text } };
    this._persist(GLOBAL_KEY, this._globals);
    return { ok: true, name: checked.name };
  }

  removeGlobal(name) {
    const next = { ...this._globals };
    delete next[name];
    this._globals = next;
    this._persist(GLOBAL_KEY, this._globals);
  }

  _persist(key, value) {
    try { this._store.set(key, value); } catch { /* best effort */ }
  }
}
