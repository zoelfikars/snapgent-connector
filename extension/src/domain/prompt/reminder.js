// SPDX-License-Identifier: GPL-3.0-or-later

import { DEFAULT_SERVER_ID } from "../tools/default-server.js";

export function compactTools(tools) {
  return (tools || [])
    .map((t) => {
      const name = t.name || "?";
      const desc = (t.description || "").split("\n")[0].trim();
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const args = Object.keys(props).join(", ");
      return `  ${name}(${args}) - ${desc}`;
    })
    .join("\n");
}

// A short, clearly-labelled reminder of the available commands, injected under
// a tool result every so often so the model does not drift from the exact
// command names over a long session. It is explicitly framed as an automatic
// snapgentV3 reminder (NOT a user message and NOT a new command to run).
// `calls` is the effective Commands per reply, when known: the model drifts from
// that limit just as easily as from the names, so the reminder restates it.
export function toolsReminder(tools, targetName = "Snapgent MCP", serverId = DEFAULT_SERVER_ID, calls) {
  const toolsString =
    `  list_commands(server: "${serverId}") - list available ${targetName} commands with full parameter details\n` +
    compactTools(tools);
  return (
    "\n\n────────────────────────────────\n" +
    "(System note from snapgentV3 - this is an automatic REMINDER, not a request and not a new result. " +
    "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
    `Reminder of the ${targetName} commands (use exact names and parameter keys; ` +
    "only this selected target is available in this session):\n" +
    toolsString +
    batchLine(calls)
  );
}

// The same words the start message uses for the limit, so the two can never disagree.
function batchLine(calls) {
  const count = Number.isFinite(calls) && calls > 0 ? Math.round(calls) : 0;
  if (!count) return "";
  return `\nYou may write at most ${count} command${count === 1 ? "" : "s"} in one reply; they run in order and are answered in one message.`;
}
