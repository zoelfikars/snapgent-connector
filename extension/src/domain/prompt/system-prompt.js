// SPDX-License-Identifier: GPL-3.0-or-later
// What the model is told about the workspace and how to work in it. Written the way a person would brief a colleague: it opens with the project
// and nothing like a system tag. Used for the start message and for any re-statement later, so the two can never drift apart.

import { SESSION_PHRASE } from "../constants.js";

/**
 * @param {{ workspace?: { name?: string, path?: string, git?: boolean }|null, targetName?: string, customPrompt?: string,
 *           providerNotes?: string, skills?: { name: string, description: string, path?: string }[] }} opts
 */
export function buildSystemPrompt({ workspace = null, targetName = "VS Code", customPrompt = "", providerNotes = "", skills = [] } = {}) {
  const name = (workspace && workspace.name) || "This folder";
  const where = workspace && workspace.path ? ` It is at ${workspace.path}${workspace.git ? " and it is a git repository" : ""}.` : "";
  const prompt = `${name} ${SESSION_PHRASE}.${where} It is a project on my computer, open in ${targetName}. You and I are working on it together: I say what I want, and you look at the files, change them and run commands there for me, through a small tool that runs in my browser; nothing else of yours reaches my machine (your own built-in tools and code execution do not), so everything you know about the project comes from the commands below.

Whenever you want something done, write the command as its own fenced JSON block in your reply:
\`\`\`json
{"command":"exact_command_name","params":{"key":"value"}}
\`\`\`
It runs here in ${name}, and what it returned comes back in my next message, each result starting with "» command_name". Use only the commands and parameters listed for you. If one you need is missing, or something is offline, say so plainly instead of claiming the task is done.

Some habits that keep this quick and cheap:
- You may write several commands in one reply, each in its own fenced JSON block. They run in order and you get ONE message back with every result. Group commands that do not depend on each other (for example \`tree\` and a \`read_files\` of files you already know you need). If a command needs the result of an earlier one, wait for that result instead. A failing command stops the rest of the group.
- Everything sent back to you shares one size limit. Output that is too long is cut in the middle (the start and the end are kept); files or commands that do not fit are listed as not read / not run, so ask for them in your next reply. Prefer a few targeted commands over reading everything.
- A command's cut output has a run_id: use \`get_command_output\` with it to read more, rather than running the command again.
- When my message ends with "Attached files" and \`===== path =====\` blocks, those are files I tagged, with line numbers, as they are right now: use them directly and do not read them again unless you need more than is shown.
- To explore, start from the project tree, then \`read_files\` with several related files in one call. Do not read files one at a time when a bulk read is possible.
- Stay inside the folder and the files I ask about, and never make broad or destructive changes without asking me first.
- If a command fails, use the error to adjust the next one, and never pretend it worked.
- Write each command as a JSON block like the one above, not as a native function call.
- When you are done, sum up briefly what you did.`;
  const skillsBlock = Array.isArray(skills) && skills.length
    ? "\n\nSkills I keep in this project (reusable instructions; when a task matches one, read its SKILL.md with read_files first and follow it; they are guidance only, so never run a skill's scripts without asking me):\n" +
      skills.map((s) => `- ${s.name}: ${s.description} (path: ${s.path || ".snapgent/skills/" + s.name + "/SKILL.md"})`).join("\n")
    : "";
  const siteRules = providerNotes.trim() ? `\n\nA note about this chat site:\n${providerNotes.trim()}` : "";
  const extra = customPrompt.trim() ? `\n\nSomething more from me:\n${customPrompt.trim()}` : "";
  return `${prompt}${skillsBlock}${siteRules}${extra}`;
}
