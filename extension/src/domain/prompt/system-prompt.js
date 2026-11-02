// SPDX-License-Identifier: GPL-3.0-or-later

import { SYS_MARKER } from "../constants.js";

// ── System prompt ─────────────────────────────────────────────────────────
// ONE unified prompt sent to every AI on the first turn. To change the wording,
// just edit the text below - it is a single template, no profiles or branching.
// `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
// `${toolsString}` is filled in with the live command list.
//
// `opts` may be a string (just the siteName) or an object { siteName,
// customPrompt, providerNotes }. `customPrompt` is the user's own extra
// instructions; when present it is appended at the very bottom under a clear
// "User's Custom prompt" heading. It NEVER edits the prompt above - it only
// adds a layer below it.
//
// `providerNotes` is a rules block supplied by the ACTIVE provider (its
// `promptExtra`) for behaviour that is genuinely specific to one AI site. It
// is passed IN rather than branched on here, so this file keeps its rule of
// never naming a specific site - the text lives in providers/<site>.js and
// every other provider is untouched by definition.
export function buildSystemPrompt(opts = {}) {
  if (typeof opts === "string") opts = { siteName: opts };
  const {
    siteName = "this AI site",
    customPrompt = "",
    providerNotes = "",
    targetServer = "vscode",
    targetName = "VS Code",
    skills = [],
  } = opts;

  const prompt = `CONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands to the user's selected MCP server through their local bridge. The selected target is ${targetName} (server id: ${targetServer}).

The extension reads commands from your normal reply text and runs them on that MCP server. Your own built-in tools, connectors, or code execution do not access the user's machine. For work on the selected target, write exactly one command per reply as a fenced JSON block:
\`\`\`json
{"command":"exact_tool_name","params":{"key":"value"}}
\`\`\`

At the start of the session, call \`list_commands\` with server "${targetServer}" to get the exact available tools and parameter schemas. Use only names and parameters from that result. Do not assume tools are available. If the needed tool is missing or the server is offline, explain that clearly and do not claim the task is complete. Do not call tools on another server unless the user asks to switch targets.

Rules:
- Execute one command at a time and wait for its result before writing another.
- Put every command in a fenced JSON code block; do not use native function calls.
- Respect the user's requested workspace and file scope. Never perform broad or destructive changes without explicit confirmation.
- For project exploration, call \`tree\` first (junk folders are excluded by default), then \`read_files\` with several related files in one call. Do not read files one at a time when a bulk read is possible.
- On errors, use the returned error to adjust the next command; do not silently claim success.
- When finished, summarize the completed work briefly.
- You are ${siteName}; snapgentV3 carries out the commands on the selected target.`;
  const skillsBlock = Array.isArray(skills) && skills.length
    ? "\n\nAvailable skills (reusable instructions stored in the workspace). When a task matches a skill's description, first read its SKILL.md with read_files, then follow it. Skills are guidance only: never run a skill's scripts without the user's confirmation.\n" +
      skills.map((s) => `- ${s.name}: ${s.description} (path: ${s.path || ".snapgent/skills/" + s.name + "/SKILL.md"})`).join("\n")
    : "";

  // Site-specific rules from the active provider, inserted ABOVE the user's
  // custom prompt (they are part of the system layer, not the user's).
  const siteRules = providerNotes.trim()
    ? `\n\n━━━ ADDITIONAL RULES FOR THIS SITE ━━━\n${providerNotes.trim()}`
    : "";

  // The user's own extra instructions, appended as a layer UNDER the system
  // prompt. Optional - empty by default. It cannot change the rules above.
  const extra = customPrompt.trim()
    ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${customPrompt.trim()}`
    : "";

  // The marker leads the prompt; it tags the bootstrap turn for camouflage.
  return `${SYS_MARKER}\n${prompt}${skillsBlock}${siteRules}${extra}`;
}
