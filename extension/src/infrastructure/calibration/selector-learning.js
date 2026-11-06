// SPDX-License-Identifier: GPL-3.0-or-later
// Turns "the user clicked this element" into a CSS selector that finds it again, and, from a reply and a user message,
// into selectors that tell the two kinds of turn apart. Candidates are tried strongest first and every one is checked
// against the live page: it must find the picked element and must not find what it has to be told apart from.

import { isInstanceSpecific, stableAttributes, stableClasses, visible } from "./dom-signals.js";

const esc = (value) => String(value).replace(/["\\]/g, "\\$&");
const escapeClass = (cls) => String(cls).replace(/[^\w-]/g, "\\$&");

/** Selector candidates for one element, strongest first. */
export function candidatesFor(el) {
  const list = [];
  const tag = el.localName;
  for (const { name, value } of stableAttributes(el)) {
    if (!isInstanceSpecific(value)) { list.push(`[${name}="${esc(value)}"]`); continue; }
    // "fallback-turn-1:1:assistant": the instance part varies, the word after the last separator does not.
    const suffix = /([:/_.-])([A-Za-z][A-Za-z_]{2,})$/.exec(value);
    if (suffix) list.push(`[${name}$="${esc(suffix[1] + suffix[2])}"]`);
    const prefix = /^([A-Za-z][A-Za-z_]{2,})([:/_.-])/.exec(value);
    if (prefix) list.push(`[${name}^="${esc(prefix[1] + prefix[2])}"]`);
  }
  if (tag.includes("-")) list.push(tag); // a custom element name is a chosen name
  for (const cls of stableClasses(el)) list.push(`.${escapeClass(cls)}`);
  return list;
}

const all = (scope, selector) => { try { return [...scope.querySelectorAll(selector)]; } catch { return []; } };

/**
 * A selector for `target` that finds none of `avoid`.
 * @param {Element} target
 * @param {{ avoid?: Element[], scope?: ParentNode, onlyVisible?: boolean, unique?: boolean }} [options]
 *   `unique`: among the (visible) matches the target must be the only one.
 *   `within`: every visible match must lie inside this element (the chat's own scrolling area): a class shared with the
 *   sidebar, the home page cards or the text box's overlay does not make a turn.
 *   `keepOut`: elements (the text box, the send button) no match may contain or sit inside: a turn is never the composer or around it.
 * @returns {string|null}
 */
export function learnSelector(target, { avoid = [], scope = target.ownerDocument, onlyVisible = false, unique = false, keepOut = [], filled = false, within = null } = {}) {
  const candidates = candidatesFor(target);
  const tag = target.localName;
  const options = [...candidates, ...candidates.flatMap((one) => (one.startsWith(".") || one.startsWith("[") ? [`${tag}${one}`] : []))];
  // Two signals together, when no single one is enough.
  for (let i = 0; i < Math.min(candidates.length, 4); i++) {
    for (let j = i + 1; j < Math.min(candidates.length, 4); j++) options.push(candidates[i] + candidates[j]);
  }
  // Sites that only have generic utility classes (Tailwind): all of the element's classes together, and the same under the
  // nearest ancestor that has a name of its own, which is what tells a reply from the many boxes sharing one class.
  const classes = stableClasses(target);
  if (classes.length > 1) {
    const signature = tag + classes.map((cls) => `.${escapeClass(cls)}`).join("");
    options.push(signature);
    for (let up = target.parentElement, hops = 0; up && hops < 8; up = up.parentElement, hops++) {
      const named = stableAttributes(up).find(({ value }) => !isInstanceSpecific(value));
      if (named) { options.push(`[${named.name}="${esc(named.value)}"] ${signature}`); break; }
    }
  }
  for (const selector of options) {
    const matches = all(scope, selector);
    if (!matches.includes(target)) continue;
    if (avoid.some((other) => matches.includes(other))) continue;
    if (keepOut.some((other) => matches.some((m) => m.contains(other) || other.contains(m)))) continue;
    if (within && matches.some((m) => visible(m) && !within.contains(m))) continue;
    if (filled && matches.some((m) => visible(m) && !m.textContent.trim() && !m.querySelector("img, svg, canvas, video"))) continue;
    if (unique && (onlyVisible ? matches.filter(visible) : matches).length !== 1) continue;
    return selector;
  }
  return null;
}

function commonAncestor(a, b) {
  const above = new Set();
  for (let n = a; n; n = n.parentElement) above.add(n);
  for (let n = b; n; n = n.parentElement) if (above.has(n)) return n;
  return null;
}

const chainBelow = (el, ancestor) => {
  const chain = [];
  for (let n = el; n && n !== ancestor; n = n.parentElement) chain.push(n);
  return chain.reverse(); // outermost first
};

/**
 * The scrolling area a chat's turns live in: the nearest ancestor that scrolls. Null when none does (a short page).
 * The sidebar, the home page and the text box are never inside it.
 */
export function chatRegion(el) {
  const win = el.ownerDocument.defaultView;
  for (let n = el.parentElement; n && n !== el.ownerDocument.body && n !== el.ownerDocument.documentElement; n = n.parentElement) {
    const overflow = win.getComputedStyle(n).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return n;
  }
  return null;
}

/**
 * From one assistant reply and one user message the user clicked, the selectors of the two kinds of turn.
 * The turn is the OUTERMOST element around the click that can be told apart from the other kind of turn; wrappers
 * both kinds share (same generated class) cannot, so the search goes inward until something does.
 * @returns {{ assistant: string, user: string, assistantTurn: Element, userTurn: Element } | { error: string }}
 */
export function learnTurnSelectors(assistantPick, userPick, keepOut = []) {
  const top = commonAncestor(assistantPick, userPick);
  if (!top || top === assistantPick || top === userPick) return { error: "The reply and the message must be different turns." };
  const within = chatRegion(top);
  const assistantChain = chainBelow(assistantPick, top);
  const userChain = chainBelow(userPick, top);
  const find = (chain, otherChain) => {
    for (const el of chain) {
      const selector = learnSelector(el, { avoid: otherChain, keepOut, filled: true, within });
      if (selector) return { selector, el };
    }
    return null;
  };
  const a = find(assistantChain, userChain);
  const u = find(userChain, assistantChain);
  if (!a) return { error: "Could not tell the reply apart from your message." };
  if (!u) return { error: "Could not tell your message apart from the reply." };
  return { assistant: a.selector, user: u.selector, assistantTurn: a.el, userTurn: u.el };
}

/**
 * The reasoning part of a reply that shares its turn with the answer, from a click inside it; null when none can be described. The part
 * must be found again by its selector, and no match may hold a code block: commands live in the answer, and a part that swallowed one
 * would hide it from the agent.
 */
export function learnThinkingSelector(turn, inner) {
  if (!inner || inner === turn || !turn.contains(inner)) return null;
  for (let el = inner; el && el !== turn; el = el.parentElement) {
    const selector = learnSelector(el, { scope: turn });
    if (!selector) continue;
    const found = all(turn, selector);
    if (found.includes(el) && !found.some((match) => match.querySelector("pre"))) return selector;
  }
  return null;
}

/**
 * The part of a reply to read, from a click inside it; null when the turn itself is the body. A part that leaves out one of
 * the reply's code blocks is grown until it holds them all: the commands the agent must read live in code blocks, and a click
 * deep inside the prose would otherwise cut them off.
 */
export function learnBodySelector(turn, inner) {
  if (!inner || inner === turn || !turn.contains(inner)) return null;
  const blocks = [...turn.querySelectorAll("pre")];
  let start = inner;
  while (start !== turn && !blocks.every((block) => start.contains(block))) start = start.parentElement;
  if (start === turn) return null;
  for (let el = start; el && el !== turn; el = el.parentElement) {
    const selector = learnSelector(el, { scope: turn });
    if (selector && all(turn, selector)[0] === el) return selector;
  }
  return null;
}
