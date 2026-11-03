// SPDX-License-Identifier: GPL-3.0-or-later
// The words every start message and every re-statement of the instructions contain ("<project> is your current workspace"). They are how the
// page recognises, later, that a conversation is a session: ordinary words, not a tag.
export const SESSION_PHRASE = "is your current workspace";

// What earlier versions put at the top of the start message. Chats begun with it are still recognised.
export const LEGACY_SESSION_MARKER = "⟦ZS-SYS⟧";
