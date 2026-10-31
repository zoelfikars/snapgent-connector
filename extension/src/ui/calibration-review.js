// SPDX-License-Identifier: GPL-3.0-or-later
// The calibration review: what the profile just learned finds on the page, laid out so the user can SEE it. Every turn is
// marked on the page as "You" or "AI reply", the part that will be read is marked, and so is the box the bar will sit in. The text
// summary lists the turns in order and says what is read from the last reply, and the warnings name what looks wrong.

import { PREVIEW_CHARS } from "./calibration-steps.js";

const MAX_MARKED = 40; // a long chat marks its first turns only; the point is to see the pattern

const brief = (text) => {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > 70 ? `${one.slice(0, 70)}…` : one || "(empty)";
};

/**
 * @param {object} provider a calibrated provider (see infrastructure/calibration/engine.js)
 * @returns {{ text: string, warnings: string[], marks: Array<{ name: string, el: Element, label: string, kind: string }>, read: string }}
 */
export function reviewOf(provider) {
  const info = provider.review();
  const read = (provider.readAssistant().reply || "").trim();
  const shown = read.length > PREVIEW_CHARS ? `${read.slice(0, PREVIEW_CHARS)}…` : read;
  const turns = provider.allItems().map((item) => `${provider.isUserItem(item) ? "You" : "AI "}: ${brief(provider.itemText(item))}`);

  const warnings = [];
  if (!info.users.length) warnings.push("It found no message of yours.");
  if (!info.assistants.length) warnings.push("It found no AI reply.");
  if (info.assistants.length && !read) warnings.push("Nothing was read from the reply.");
  if (info.codeBlocks > info.codeBlocksRead) warnings.push(`The part read leaves out ${info.codeBlocks - info.codeBlocksRead} of the reply's ${info.codeBlocks} code block(s), which is where commands are written.`);

  const marks = [
    ...info.users.slice(0, MAX_MARKED).map((el, i) => ({ name: `rv:user${i}`, el, label: "You", kind: "user" })),
    ...info.assistants.slice(0, MAX_MARKED).map((el, i) => ({ name: `rv:ai${i}`, el, label: "AI reply", kind: "ai" })),
  ];
  if (info.body) marks.push({ name: "rv:body", el: info.body, label: "Read from here", kind: "body" });

  const codeLine = info.codeBlocks ? `\nCode blocks in the last reply: ${info.codeBlocks} (${info.codeBlocksRead} read)` : "";
  const text = `Found ${info.users.length} message(s) of yours and ${info.assistants.length} AI reply(ies):\n${turns.join("\n")}${codeLine}\n\nLast AI reply, as it will be read:\n${shown || "(nothing)"}`;
  return { text, warnings, marks, read };
}
