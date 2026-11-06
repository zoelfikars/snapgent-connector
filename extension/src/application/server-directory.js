// SPDX-License-Identifier: GPL-3.0-or-later
// Which MCP servers the user can pick as the target, which of them are switched on, and the extra
// instructions the user wants appended to the system prompt. The bridge is the source of truth for
// which servers exist; what is kept here is only display names, the on/off toggles and the prompt.

import { DEFAULT_SERVER_ID, migratedToggles } from "../domain/tools/default-server.js";

const KEYS = { toggles: "zsMcpEnabled", custom: "zsCustomMcpServers", prompt: "zsCustomPrompt" };
const BUILT_IN = { id: DEFAULT_SERVER_ID, name: "Snapgent MCP" };

const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export class ServerDirectory {
  /**
   * @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: *) => void },
   *           liveServers: () => Array<{ id: string, alive?: boolean, tools?: * }>,
   *           onChange?: () => void, log?: (...args: unknown[]) => void }} deps
   */
  constructor({ store, liveServers, onChange = () => {}, log = () => {} }) {
    Object.assign(this, { _store: store, _live: liveServers, _onChange: onChange, _log: log });
    this._toggles = {};   // { serverId: boolean }; never toggled counts as enabled
    this._custom = [];    // [{ id, name, command? }] display cache of servers the user added
    this._prompt = "";
    /** Resolves once the persisted values are loaded. Reads before that see the defaults. */
    this.ready = Promise.all([
      this._hydrate(KEYS.toggles, isPlainObject, (v) => { this._toggles = migratedToggles(v); if (this._toggles !== v) this._store.set(KEYS.toggles, this._toggles); this._onChange(); }),
      this._hydrate(KEYS.custom, Array.isArray, (v) => { this._custom = v; }),
      this._hydrate(KEYS.prompt, (v) => typeof v === "string", (v) => { this._prompt = v; }),
    ]);
  }

  async _hydrate(key, valid, assign) {
    try {
      const saved = await this._store.get(key);
      if (valid(saved)) assign(saved);
    } catch (error) {
      this._log(`Could not load ${key}:`, error);
    }
  }

  get customPrompt() { return this._prompt; }

  isEnabled(id) { return this._toggles[id] !== false; }

  setEnabled(id, on) {
    this._toggles = { ...this._toggles, [id]: !!on };
    this._store.set(KEYS.toggles, this._toggles);
  }

  /** Every non-built-in server, with the bridge's live health. Servers only the cache knows (mid-restart) are kept. */
  servers() {
    const live = this._live().filter((server) => server.id !== BUILT_IN.id);
    const cached = new Map(this._custom.map((server) => [server.id, server]));
    const merged = live.map((server) => {
      const known = cached.get(server.id);
      return { id: server.id, name: (known && known.name) || server.id, command: known && known.command, alive: server.alive, tools: server.tools };
    });
    // Self-heal: the cache did not know a server the bridge actually has.
    const unknown = live.filter((server) => !cached.has(server.id));
    if (unknown.length) {
      this._custom = [...this._custom, ...unknown.map((server) => ({ id: server.id, name: server.id }))];
      this._store.set(KEYS.custom, this._custom);
    }
    // Added/removed a moment ago and the bridge has not reported back yet: keep it listed, health unknown.
    for (const server of this._custom) {
      if (!merged.some((entry) => entry.id === server.id)) merged.push({ ...server, alive: undefined, tools: undefined });
    }
    return merged;
  }

  name(id) {
    if (id === BUILT_IN.id) return BUILT_IN.name;
    const server = this.servers().find((entry) => entry.id === id);
    return server ? server.name : id;
  }

  /** Every server that could be a target, enabled or not (what the settings popup lists). */
  allOptions() {
    return [BUILT_IN, ...this.servers().map((server) => ({ id: server.id, name: server.name }))];
  }

  /** What the target dropdown offers: the enabled servers, plus `currentId` even if it is gone or disabled. */
  targetOptions(currentId) {
    const options = this.allOptions().filter((option) => this.isEnabled(option.id));
    if (!options.some((option) => option.id === currentId)) options.push({ id: currentId, name: currentId });
    return options;
  }

  /** The first enabled server, used when the active target has just been switched off. */
  firstEnabled() {
    return this.allOptions().find((option) => this.isEnabled(option.id)) || null;
  }
}
