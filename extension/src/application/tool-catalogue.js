// SPDX-License-Identifier: GPL-3.0-or-later
// Holds the tool catalogue advertised by the bridge: fetching with a short TTL,
// scoping to the selected server, and resolving names. One reason to change:
// how the catalogue is cached and queried.

import { isKnownName } from "../domain/tools/names.js";
import { serverOf } from "../domain/tools/virtual-commands.js";

const DEFAULT_TTL_MS = 30000;

export class ToolCatalogue {
  /**
   * @param {{ bridge: import("./ports.js").BridgePort,
   *           session: Pick<import("./ports.js").SessionPort, "target"|"isEnabled">,
   *           now?: () => number, ttlMs?: number, diag?: (event: string, data?: object) => void }} deps
   */
  constructor({ bridge, session, now = Date.now, ttlMs = DEFAULT_TTL_MS, diag = () => {} }) {
    this._bridge = bridge;
    this._session = session;
    this._now = now;
    this._ttlMs = ttlMs;
    this._diag = diag;
    this._tools = [];
    this._fetchedAt = 0;
  }

  /** Every advertised tool, across servers. */
  get all() { return this._tools; }

  hasAny() { return this._tools.length > 0; }

  /** Tools of the selected server, or none when that server is toggled off. */
  active() {
    const target = this._session.target();
    if (!this._session.isEnabled(target)) return [];
    return this._tools.filter((tool) => serverOf(tool) === target);
  }

  names() { return new Set(this.active().map((tool) => tool.name)); }

  knows(name) { return isKnownName(this.names(), name); }

  /**
   * Refresh the catalogue, but never pay for it twice in a row: a dead MCP server
   * makes list_tools slow, and the boot sequence asks three times in a few seconds.
   * A failed or empty refresh keeps what we already have.
   */
  async ensure(force = false) {
    if (!force && this._tools.length && this._now() - this._fetchedAt < this._ttlMs) {
      this._diag("tools.cached", { age: this._now() - this._fetchedAt, n: this._tools.length });
      return this._tools;
    }
    const startedAt = this._now();
    const response = await this._bridge.listTools();
    const fetched = (response && response.tools) || [];
    this._diag("tools.fetched", { ms: this._now() - startedAt, n: fetched.length });
    if (fetched.length) {
      this._tools = fetched;
      this._fetchedAt = this._now();
    }
    return this._tools;
  }
}
