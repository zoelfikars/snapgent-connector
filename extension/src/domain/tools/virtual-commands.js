// SPDX-License-Identifier: GPL-3.0-or-later
// Commands the extension answers itself (they never reach the bridge).

import { resultHeader } from "./result-marker.js";
import { formatCatalogue } from "./catalogue.js";

export const LIST_SERVERS = "list_mcp_servers";
export const isListCommands = (name) => name === "list_commands" || name === "list_tools";

/** A tool without a "server" tag comes from an older bridge: treat it as the default server. */
export const serverOf = (tool) => tool.server || "vscode";

/**
 * @param {{ servers: Array<{id:string, alive?:boolean, tools?:number}>, target: string }} input
 *   `servers` must already be limited to the selected, enabled server.
 */
export function renderServerList({ servers, target }) {
  const lines = servers.length
    ? servers.map((sv) => {
        const label = sv.id === "vscode" ? "VS Code (default target)" : `${sv.id} (addon)`;
        return `- ${sv.id}: ${label} - ${sv.alive ? `${sv.tools || 0} commands available` : "offline (no tools)"}`;
      })
    : ["- vscode: VS Code (default target) - unknown (bridge did not report server health)"];
  return (
    `${resultHeader(LIST_SERVERS)}\n` +
    `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
    `Use list_commands with a "server" param (one of the ids above) to see that server's exact commands. Without "server", list_commands defaults to "${target}".`
  );
}

/**
 * @param {{ name: string, target: string, asked?: string, enabled: boolean, tools: object[] }} input
 *   `tools` is the full advertised catalogue; it is scoped to `target` here.
 */
export function renderCommandList({ name, target, asked = "", enabled, tools }) {
  const out = (body) => `${resultHeader(name)}\n${body}`;
  // Only the selected server can be listed. Asking for any other gets a generic
  // refusal that does not reveal whether that server exists or is connected.
  if (asked && asked !== target) {
    return out(`ERROR: server "${asked}" is not available. Only the selected target "${target}" can be used in this session. Do NOT try other servers; ask the user to switch the target in the snapgentV3 selector if needed.`);
  }
  if (!enabled) {
    return out(`ERROR: MCP server "${target}" is disabled by the user. Do NOT use it. Tell the user to enable it in the MCP settings if it is needed.`);
  }
  if (!tools.length) return out("No commands available - the bridge or selected MCP server may be offline.");
  const scoped = tools.filter((tool) => serverOf(tool) === target);
  if (!scoped.length) {
    return out(`ERROR: the selected server "${target}" has no commands available (it may be offline). Do NOT try other servers; tell the user to check the target in the snapgentV3 selector.`);
  }
  return out(`${target} commands (${scoped.length}):\n\n${formatCatalogue(scoped)}`);
}
