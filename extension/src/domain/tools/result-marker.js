// SPDX-License-Identifier: GPL-3.0-or-later
// The first line of every result sent back to the model, and how to recognise a message of ours later (to count it toward
// the system-prompt budget, or to tell that a chat is a session). It is the command's bare name behind a "»", which reads
// as plain text rather than as a protocol. The wording older versions used is still recognised, so chats started with
// them keep working. Pure.

/** @param {string} name */
export const resultHeader = (name) => `» ${name}`;

const HEADER = String.raw`(?:»[ \t]+\S+[ \t]*(?:\n|$)|Output of '[^']*':)`;
const AT_START = new RegExp(`^\\s*${HEADER}`);
const ON_A_LINE = new RegExp(`(?:^|\\n)\\s*${HEADER}`);
const LEADING_HEADER = /^\s*(?:»[ \t]+\S+[ \t]*|Output of '[^']*':)\n?/;

/** Does this message BEGIN with a result of ours? */
export const startsWithResult = (text) => AT_START.test(text);

/** Is there a result of ours anywhere in this text (a turn may carry other text before it)? */
export const containsResult = (text) => ON_A_LINE.test(text);

/** A result without its first line. */
export const withoutResultHeader = (feedback) => feedback.replace(LEADING_HEADER, "");
