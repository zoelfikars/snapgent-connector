// SPDX-License-Identifier: GPL-3.0-or-later
// What can be trusted on a page element when a site is calibrated: which attributes and class names are stable
// (a name someone chose) and which are noise (a build hash, an instance id, a state that toggles).

/** Laid out and attached. */
export const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

// Attributes that change while the page is used, or that browser add-ons stamp on inputs.
const DYNAMIC_ATTRIBUTE = /^(data-placeholder|data-state|data-zs|data-csig|data-focus|data-hover|data-active|data-highlighted|data-orientation|data-disabled|data-selected|data-radix|data-headlessui|data-ecto-composer-prehydration|data-gramm|data-enable-grammarly|data-1p|data-lp|data-bw|data-form-type|data-ssr|data-react|data-reactid|data-v-)/;

/** A class or token that looks generated: `block-BQZwFn`, `d29f3d7d`, `css-1abc2de`. */
export function isHashedToken(token) {
  if (/\d/.test(token) && /[a-z]/i.test(token) && token.length >= 6) return true;
  const tail = /-([A-Za-z0-9]{5,8})$/.exec(token);
  return !!tail && /[a-z]/.test(tail[1]) && /[A-Z]/.test(tail[1]);
}

/** A value that differs from one instance to the next (an id, a counter, "turn-3:3:assistant"), so only a part of it can be matched. */
export const isInstanceSpecific = (value) => /\d/.test(value) || value.length > 48;

/** The attributes worth describing an element by, in the order they should be tried. */
export function stableAttributes(el) {
  const out = [];
  for (const attr of [...el.attributes]) {
    const name = attr.name;
    const value = attr.value;
    if (!value || DYNAMIC_ATTRIBUTE.test(name)) continue;
    if (name === "class" || name === "style" || name === "id" || name === "href" || name === "src") continue;
    if (/^(data-|aria-label$|role$|name$|contenteditable$)/.test(name)) out.push({ name, value });
  }
  // A role can change with the page's state (a composer is a "combobox" in a new chat and a "textbox" in an open one), so it comes last.
  const rank = (name) => (/testid|test-id|data-qa/.test(name) ? 0 : name === "aria-label" ? 1 : name.startsWith("data-") ? 2 : name === "role" ? 4 : 3);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

// Classes that say what state an element is in (empty, focused, open), not what it is.
const STATE_CLASS = /^(is-|has-|ProseMirror-|focus|active$|open$|opened$|closed$|disabled$|selected$|hover|loading$|empty$)/;

/** Class names someone chose (not generated, not a state). */
export const stableClasses = (el) => [...el.classList].filter((c) => !isHashedToken(c) && !STATE_CLASS.test(c) && !c.startsWith("zs-"));

// What a page changes between one state and another: a new chat and an open one, an empty box and a full one.
const VOLATILE_ATTRIBUTES = ["role", "placeholder", "data-placeholder", "aria-expanded", "aria-autocomplete", "aria-multiline", "aria-disabled", "aria-busy", "aria-pressed", "aria-checked", "aria-selected", "aria-activedescendant", "aria-controls"];
const VOLATILE_CLAUSE = new RegExp(`\\[\\s*(?:${VOLATILE_ATTRIBUTES.join("|")})\\s*(?:[~|^$*]?=\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\]\\s]+)(?:\\s+[is])?)?\\s*\\]`, "g");
const STATE_CLASS_CLAUSE = /\.(?:is-[\w-]+|has-[\w-]+|ProseMirror-[\w-]+|focus[\w-]*|active|open|opened|closed|disabled|selected)(?![\w-])/g;

// A text box's role depends on the page's state (a "combobox" while it offers suggestions, a "textbox" otherwise).
const TEXT_BOX_ROLES = ["textbox", "combobox", "searchbox"];
const TEXT_BOX_ROLE = /\[\s*role\s*=\s*(["']?)(textbox|combobox|searchbox)\1\s*\]/;

/**
 * The other forms a selector may take in another state of the page, most likely first: with what changes left out, and with a text
 * box's role swapped for its sibling roles. The selector itself is not among them.
 */
export function alternativeSelectors(selector) {
  const forms = [relaxSelector(selector)];
  const role = TEXT_BOX_ROLE.exec(selector);
  if (role) for (const other of TEXT_BOX_ROLES.filter((name) => name !== role[2])) forms.push(selector.replace(TEXT_BOX_ROLE, `[role="${other}"]`));
  return [...new Set(forms)].filter((form) => form && form !== selector);
}

/**
 * A selector learned in one state of a page, with the parts that change between states left out (`[role="combobox"]`,
 * `[data-placeholder="…"]`, `.is-empty`). Null when nothing would change, or when too little is left to point at one thing.
 */
export function relaxSelector(selector) {
  const relaxed = selector.replace(VOLATILE_CLAUSE, "").replace(STATE_CLASS_CLAUSE, "").replace(/\s+/g, " ").trim();
  return relaxed && relaxed !== selector && /[[.#]/.test(relaxed) ? relaxed : null;
}
