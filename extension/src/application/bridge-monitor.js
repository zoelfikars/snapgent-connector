// SPDX-License-Identifier: GPL-3.0-or-later
// What the bar needs to know about the bridge: is the selected MCP server connected and usable, did the
// connection just drop or come back, and (for VS Code) is a workspace actually open. The workspace is probed
// by listing its root, at most once per probe interval, never two at a time.

export const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;

export class BridgeMonitor {
  /**
   * @param {{ ensureTools: () => Promise<*>, activeTools: () => Array<{ name: string }>,
   *           listRoot: (toolName: string, timeoutMs: number) => Promise<{ ok?: boolean }>,
   *           isListTool: (toolName: string) => boolean,
   *           now?: () => number, onChange?: () => void, log?: (...args: unknown[]) => void }} deps
   */
  constructor({ ensureTools, activeTools, listRoot, isListTool, now = Date.now, onChange = () => {}, log = () => {} }) {
    Object.assign(this, { _ensureTools: ensureTools, _activeTools: activeTools, _listRoot: listRoot, _isListTool: isListTool, _now: now, _onChange: onChange, _log: log });
    this.bridgeOk = false;
    this.workspaceReady = false;
    this.workspaceProbePending = false;
    this._probeAt = 0;
    this._wasConnected = false;
  }

  /**
   * Digest one status report from the background worker.
   * @param {{ connected?: boolean, servers?: Array<{ id: string, alive?: boolean, tools?: number }> }} status
   * @param {string} targetId the selected MCP target
   * @returns {{ lost: boolean, connected: boolean }} `lost`: it was connected a moment ago and is not any more
   */
  update(status, targetId) {
    const selected = (status.servers || []).find((item) => item.id === targetId);
    const serverConnected = !!status.connected && !!selected && !!selected.alive;
    const usable = () => serverConnected && ((selected.tools || 0) > 0 || this._activeTools().length > 0);
    this.bridgeOk = usable();
    const lost = this._wasConnected && !status.connected;
    this._wasConnected = !!status.connected;

    if (targetId === "vscode" && serverConnected && !this.workspaceProbePending && this._now() - this._probeAt >= PROBE_INTERVAL_MS) {
      this._probe(usable);
    } else if (targetId === "vscode" && !serverConnected) {
      this.workspaceReady = false;
    }
    return { lost, connected: !!status.connected };
  }

  _probe(usable) {
    this._probeAt = this._now();
    this.workspaceProbePending = true;
    Promise.resolve(this._ensureTools()).then(() => {
      const listTool = this._activeTools().find((tool) => this._isListTool(tool.name));
      this.bridgeOk = usable();
      if (!listTool) { this.workspaceReady = false; return undefined; }
      return this._listRoot(listTool.name, PROBE_TIMEOUT_MS).then((result) => { this.workspaceReady = !!(result && result.ok); });
    }).catch((error) => {
      this.workspaceReady = false;
      this._log("Could not verify VS Code workspace:", error);
    }).finally(() => {
      this.workspaceProbePending = false;
      this._onChange();
    });
  }
}
