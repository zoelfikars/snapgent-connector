// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the tutorial's Markdown into plain blocks. Pure: text in, data out. It knows only what a tutorial needs (headings, paragraphs,
// lists, code blocks, bold and inline code) plus one line of its own, `@gambar(file.png)`, which marks where an image goes.

const IMAGE = /^@gambar\(\s*([^)]+?)\s*\)\s*$/;
const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
const SIZE_OPTION = /^(width|height|w|h)\s*=\s*(\d{1,4}%?)$/i;

// `@gambar(file.png, width=300, height=50%)`: the name comes first; a side that is not given stays automatic.
function imageBlock(inner) {
  const [name, ...options] = inner.split(",").map((part) => part.trim());
  const block = { type: "image", name };
  for (const option of options) {
    const match = SIZE_OPTION.exec(option);
    if (!match || parseInt(match[2], 10) <= 0) continue;
    block[match[1][0].toLowerCase() === "w" ? "width" : "height"] = match[2];
  }
  return block;
}
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

/**
 * @typedef {{type: "heading", level: number, text: string} | {type: "paragraph", text: string} | {type: "list", ordered: boolean, items: string[]}
 *   | {type: "code", text: string} | {type: "image", name: string, width?: string, height?: string}} TutorialBlock
 */

/** @param {string} markdown @returns {TutorialBlock[]} */
export function parseTutorial(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push(list);
    paragraph = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      // Everything inside a fence is literal, so the image marker can be shown as an example.
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const image = IMAGE.exec(line.trim());
    if (image) { flush(); blocks.push(imageBlock(image[1])); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); continue; }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /^\s*\d/.test(line);
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      if (!list) list = { type: "list", ordered, items: [] };
      list.items.push(item[1]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** The image file names a tutorial refers to, each once, in order of appearance. */
export function imageNames(markdown) {
  return [...new Set(parseTutorial(markdown).filter((block) => block.type === "image").map((block) => block.name))];
}

/** Splits a line of text into plain, **bold** and `code` pieces. @returns {Array<{t: "text"|"b"|"code", v: string}>} */
export function parseInline(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return { t: "b", v: part.slice(2, -2) };
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return { t: "code", v: part.slice(1, -1) };
    return { t: "text", v: part };
  });
}
