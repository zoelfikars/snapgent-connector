// SPDX-License-Identifier: GPL-3.0-or-later
// What can be trusted on a page element when a site is calibrated: which attributes and class names are stable
// (a name someone chose) and which are noise (a build hash, an instance id, a state that toggles).

/** Laid out and attached. */
export const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

// Attributes that change while the page is used, or that browser add-ons stamp on inputs.
const DYNAMIC_ATTRIBUTE = /^(data-state|data-zs|data-csig|data-focus|data-hover|data-active|data-highlighted|data-orientation|data-disabled|data-selected|data-radix|data-headlessui|data-ecto-composer-prehydration|data-gramm|data-enable-grammarly|data-1p|data-lp|data-bw|data-form-type|data-ssr|data-react|data-reactid|data-v-)/;

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
    if (/^(data-|aria-label$|role$|name$|placeholder$|contenteditable$)/.test(name)) out.push({ name, value });
  }
  const rank = (name) => (/testid|test-id|data-qa/.test(name) ? 0 : name === "role" ? 1 : name === "aria-label" ? 2 : name.startsWith("data-") ? 3 : 4);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

/** Class names someone chose (not generated). */
export const stableClasses = (el) => [...el.classList].filter((c) => !isHashedToken(c) && !c.startsWith("zs-"));
