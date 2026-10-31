// SPDX-License-Identifier: GPL-3.0-or-later
// ── Tool → visual category (icon + colour theme for the chips) ─────────
// Returns one of: read | edit | tool. ("screen" is assigned at run time by
// core/main.js to any tool that actually returned an image.)
const READ_TOOLS = /^(list_commands|list_tools|get_[a-z_]+|list_[a-z_]+|find_files|search_files|read_[a-z_]+|git_(status|diff|log|branches))$/;
const EDIT_TOOLS = /^(create_file|write_file|edit_file|apply_patch|create_directory|move_file|copy_file|delete_file|git_(add|commit))$/;
export function toolCategory(name) {
  const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
  if (READ_TOOLS.test(n)) return "read";
  if (EDIT_TOOLS.test(n)) return "edit";
  return "tool";
}
