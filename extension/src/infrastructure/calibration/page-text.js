// SPDX-License-Identifier: GPL-3.0-or-later
// Reading text out of a chat page the way a person sees it: blocks on their own lines, <br> as a line break, and
// our own chips (and anything else the caller names) left out.

// What a page hides from the eye but keeps for screen readers ("You said", "Gemini said"): not part of the message.
const NOT_READ = ".cdk-visually-hidden, .visually-hidden, .sr-only, .screen-reader-only, script, style, template";
const BLOCK = /^(ADDRESS|ARTICLE|BLOCKQUOTE|DIV|LI|P|PRE|SECTION|UL|OL|H[1-6])$/;

export function readText(root, excludeSelector = "") {
  if (!root) return "";
  const skip = [".zs-chip", NOT_READ, excludeSelector].filter(Boolean).join(",");
  let text = "";
  const TEXT = 3;
  const ELEMENT = 1;
  const walk = (node) => {
    if (node.nodeType === TEXT) { text += node.nodeValue || ""; return; }
    if (node.nodeType !== ELEMENT || (skip && node.matches(skip))) return;
    if (node.tagName === "BR") { text += "\n"; return; }
    const block = BLOCK.test(node.tagName);
    if (block && text && !text.endsWith("\n")) text += "\n";
    for (const child of node.childNodes) walk(child);
    if (block && !text.endsWith("\n")) text += "\n";
  };
  walk(root);
  return text;
}
