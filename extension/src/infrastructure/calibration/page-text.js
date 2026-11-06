// SPDX-License-Identifier: GPL-3.0-or-later
// Reading text out of a chat page the way a person sees it: blocks on their own lines, <br> as a line break, and
// what a page only keeps for screen readers left out.

// What a page hides from the eye but keeps for screen readers ("You said", "Gemini said"): not part of the message.
const NOT_READ = ".cdk-visually-hidden, .visually-hidden, .sr-only, .screen-reader-only, script, style, template";
const BLOCK = /^(ADDRESS|ARTICLE|BLOCKQUOTE|DIV|LI|P|PRE|SECTION|UL|OL|H[1-6])$/;

// A selector from a stored or imported profile may not parse; that must not break reading.
const skipped = (node, skip) => { if (!skip) return false; try { return node.matches(skip); } catch { return false; } };

/** `skip`: a selector for parts that are not read (the reasoning that sits inside the reply). */
export function readText(root, skip = null) {
  if (!root) return "";
  let text = "";
  const TEXT = 3;
  const ELEMENT = 1;
  const walk = (node) => {
    if (node.nodeType === TEXT) { text += node.nodeValue || ""; return; }
    if (node.nodeType !== ELEMENT || node.matches(NOT_READ) || skipped(node, skip)) return;
    if (node.tagName === "BR") { text += "\n"; return; }
    const block = BLOCK.test(node.tagName);
    if (block && text && !text.endsWith("\n")) text += "\n";
    for (const child of node.childNodes) walk(child);
    if (block && !text.endsWith("\n")) text += "\n";
  };
  walk(root);
  return text;
}
