// SPDX-License-Identifier: GPL-3.0-or-later
// What ChatGPT's page looks like, per layout it has shipped. The site changes its markup
// without notice, so layouts are DATA: when it changes again, add one entry (and a fixture
// in test/fixtures) instead of editing adapter logic.
//
// A layout answers four questions about a "turn" element: which elements are turns, who
// wrote one, where its reply text is, and what stable id it has.

const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);

/** @typedef {{ name: string, turns: string, role: (el: Element) => string|null, reply: string, id: (el: Element) => string|null }} Layout */

/** @type {Layout[]} newest last; the first layout whose `turns` matches the page wins */
export const CHATGPT_LAYOUTS = [
  {
    // <div data-message-author-role="user|assistant"> with a stable data-message-id; replies in
    // .markdown. A later redesign rendered replies in .DilResponseRoot-* without those attributes.
    name: "classic",
    turns: '[data-message-author-role],[class*="DilResponseRoot"]',
    role: (el) => attr(el, "data-message-author-role") || (el.matches('[class*="DilResponseRoot"]') ? "assistant" : null),
    reply: ".markdown",
    id: (el) => attr(el, "data-message-id"),
  },
  {
    // 2026-10: one wrapper per message, <div data-content-search-unit-key="fallback-turn-1:1:assistant">.
    // The key ends with the role. Reply text lives in [data-markdown-text-style="assistant-message"];
    // the message UUID sits on a descendant (data-chatgpt-selection-message-id).
    name: "search-units-2026-10",
    turns: "[data-content-search-unit-key]",
    role: (el) => {
      const role = (attr(el, "data-content-search-unit-key") || "").split(":").pop();
      return role === "user" || role === "assistant" ? role : null;
    },
    reply: '[data-markdown-text-style="assistant-message"]',
    id: (el) => {
      const inner = el.querySelector("[data-chatgpt-selection-message-id]");
      return attr(inner, "data-chatgpt-selection-message-id") || attr(el, "data-content-search-unit-key");
    },
  },
];

/** Every layout's turn selector, for "is this element part of a message?" questions. */
export const ANY_TURN_SELECTOR = CHATGPT_LAYOUTS.map((layout) => layout.turns).join(",");

/** The layout this page uses, or null when none is recognised. */
export function pickLayout(doc) {
  return CHATGPT_LAYOUTS.find((layout) => doc.querySelector(layout.turns)) || null;
}

/** The layout a given turn element belongs to. */
export function layoutOf(el) {
  return CHATGPT_LAYOUTS.find((layout) => el && el.matches && el.matches(layout.turns)) || null;
}
