// SPDX-License-Identifier: GPL-3.0-or-later
// Wire-format markers of a snapgentV3 command. Pure constants, shared by every
// parser module so the format is defined in exactly one place.

export const START_M = "###MCP_TOOL###";
export const END_M = "###END_MCP_TOOL###";

// A command is `{"command":"name", ...}` (or "tool"). "params" is optional (`{"command":"list_commands"}`), so what is keyed on is a
// string-valued "command"/"tool" key, which prose almost never contains.
export const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;

// DeepSeek's own tool-call markup ("DSML"), sometimes written instead of a command:
//   <|DSML|>tool_calls>  <|DSML|>invoke name="script_read">  <|DSML|>parameter name="target_file" string="true">…</|DSML|>parameter>
// It has no "command" key, so it is recognised on its own (whatever tool it names, or none) and answered with a parse error: we cannot
// read it. Any run of bars and spaces on either side is accepted (ASCII, doubled, or full-width U+FF5C).
export const DSML_RE = /<[\s\/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;
