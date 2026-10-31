// SPDX-License-Identifier: GPL-3.0-or-later
// Tool-name helpers. The bridge advertises names with a "server/" prefix only when
// two MCP servers expose the same tool, while the model always writes the bare name.

export const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";

const bareKey = (name) => String(name || "").split("/").pop().split(".").pop();

/** Is `name` one of `names` (a Set of advertised names), ignoring any server prefix? */
export function isKnownName(names, name) {
  if (!name || !names.size) return false;
  if (names.has(name) || names.has(bareToolName(name))) return true;
  const wanted = bareKey(name);
  for (const advertised of names) if (bareKey(advertised) === wanted) return true;
  return false;
}
