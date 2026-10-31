// SPDX-License-Identifier: GPL-3.0-or-later
// Execution is hard-limited to the one MCP server the user selected.

/**
 * @returns {string|null} an ERROR message for the model, or null when `name` may run.
 */
export function isolationError({ name, target, targetEnabled }) {
  if (!targetEnabled) {
    return `ERROR: the selected MCP server "${target}" is disabled by the user, so '${name}' was not run. Do NOT retry. Tell the user to enable it in the MCP settings.`;
  }
  if (name.includes("/") && name.split("/")[0] !== target) {
    return `ERROR: '${name}' was not run. Only the selected target "${target}" can be used in this session. Use plain command names from list_commands.`;
  }
  return null;
}
