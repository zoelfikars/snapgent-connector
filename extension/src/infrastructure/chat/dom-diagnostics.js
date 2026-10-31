// SPDX-License-Identifier: GPL-3.0-or-later
// When an adapter cannot find what it expects, the useful question is "what does the page
// actually look like around the text we KNOW is there?". These helpers answer it compactly,
// so a layout change can be fixed from one log line instead of a screen-share.

const INTERESTING_ATTRIBUTE = /^(data-|role$|id$|aria-label$)/;
const VALUE_LIMIT = 40;

/** `div[data-x="…"][role="…"].class1.class2`, short enough to read in a log. */
export function describeElement(el) {
  const attrs = [...el.attributes]
    .filter((a) => INTERESTING_ATTRIBUTE.test(a.name))
    .map((a) => `[${a.name}="${a.value.slice(0, VALUE_LIMIT)}"]`)
    .join("");
  const classes = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
    : "";
  return `${el.tagName.toLowerCase()}${attrs}${classes}`;
}

/**
 * The element chain (innermost first) of the LAST text node containing `needle`.
 * @returns {string[]} empty when the text is not on the page
 */
export function describeAnchor(doc, needle, maxDepth = 14) {
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes(needle)) last = node;
  }
  const chain = [];
  for (let el = last && last.parentElement; el && chain.length < maxDepth; el = el.parentElement) {
    chain.push(describeElement(el));
  }
  return chain;
}
