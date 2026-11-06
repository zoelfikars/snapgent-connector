// SPDX-License-Identifier: GPL-3.0-or-later
// The first message of a session. Everything the model would otherwise have to ask for one command at a time (which commands exist, what
// the project looks like) is in it, so the model's whole part of the start is one short answer. Pure.

/** @param {{ prompt: string, commands: string, tree?: string, context?: { name: string, text: string } | null }} parts */
export function buildStartMessage({ prompt, commands, tree = "", context = null }) {
  const parts = [prompt];
  if (context) parts.push(`Project instructions from ${context.name}:\n\n${context.text.trim()}\n\n(Files this text mentions are not included here: read them with read_files when they matter.)`);
  parts.push(`These are the commands you can use here:\n\n${commands.trim()}`);
  if (tree.trim()) parts.push(`This is what the project looks like (folders such as node_modules and .git are left out):\n\n${tree.trim()}`);
  parts.push('If that is all clear, just reply "understood" and wait. Do not run anything yet: I will tell you what I want to do.');
  return parts.join("\n\n");
}
