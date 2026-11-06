// SPDX-License-Identifier: GPL-3.0-or-later
// The id of the MCP server every install has (it runs the workspace commands). Older versions called it "vscode"; what they stored under
// that id is read as the new one. Pure.

export const DEFAULT_SERVER_ID = "snapgent";
export const LEGACY_SERVER_ID = "vscode";

/** A stored target id: the old name of the default server means the default server. */
export const migratedTarget = (id) => (id === LEGACY_SERVER_ID ? DEFAULT_SERVER_ID : id);

/** Stored on/off switches per server, with the old name moved to the new one (an entry already under the new name wins). */
export function migratedToggles(toggles) {
  if (!toggles || !(LEGACY_SERVER_ID in toggles)) return toggles;
  const { [LEGACY_SERVER_ID]: legacy, ...rest } = toggles;
  return DEFAULT_SERVER_ID in rest ? rest : { ...rest, [DEFAULT_SERVER_ID]: legacy };
}
