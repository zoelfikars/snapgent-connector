// SPDX-License-Identifier: GPL-3.0-or-later
// Wire-format markers of a snapgentV3 command. Pure constants, shared by every
// parser module so the format is defined in exactly one place.

export const START_M = "###MCP_TOOL###";
export const END_M = "###END_MCP_TOOL###";

// A command is `{"command":"name", ...}` (or "tool"). The params/arguments
// object is OPTIONAL: paramless commands like list_commands are written as
// `{"command":"list_commands"}`, so requiring "params" too would MISS them
// (they'd be shown raw and never executed). We key on the `"command":"…"` /
// `"tool":"…"` shape instead - a string-valued key, which prose almost never
// contains - so paramless calls are detected without false-positiving on text.
export const CMD_KEY_RE = /"(?:command|tool)"\s*:\s*"/;

// DeepSeek's OWN agentic tool-call markup ("DSML"), which it sometimes emits
// instead of a snapgentV3 command - seen live in user reports, DeepSeek only:
//   <|DSML|>tool_calls>
//   <|DSML|>invoke name="script_read">
//   <|DSML|>parameter name="target_file" string="true">…</|DSML|>parameter>
//   </|DSML|>tool_calls>
// It carries no "command"/"tool" key and no ###…### markers, so every guard in
// the classify ladder missed it and the turn finalized as a plain-text answer:
// the tool never ran and the loop ended with the user watching a dead agent.
// Matches the opener AND the closing "</|DSML|>…" form. Verified live
// 2026-08-22: DeepSeek emits PLAIN ASCII bars, `<|DSML|>tool_calls>`. The
// doubled "< |  | DSML |  |" seen in user screenshots is only how the site
// RENDERS it, but the class is deliberately permissive - any run of bars and
// spaces on either side - so a build that really does emit doubled or
// full-width (U+FF5C) bars is covered too, without needing another sample. Deliberately NOT
// gated on a known tool name: the degenerate case seen in the wild is a bare
// `<|DSML|>tool_calls>` with no invoke and no name at all, and the marker
// itself never occurs in ordinary prose.
export const DSML_RE = /<[\s\/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;

// Cheap "does this text look like it contains a command?" test used by the chat
// adapters to decide whether to mask a reply behind a chip.
export const COMMAND_SHAPE_RE = /"(?:command|tool)"\s*:\s*"|###mcp_tool###/i;
