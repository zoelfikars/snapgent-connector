// SPDX-License-Identifier: GPL-3.0-or-later
// DeepSeek's own tool-call markup ("DSML"), written instead of a command:
//   <｜｜DSML｜｜ calls>
//     <｜｜DSML｜｜ invoke name="read_files">
//       <｜｜DSML｜｜ parameter name="paths" string="false">["a.go"]</｜｜DSML｜｜ parameter>
//     </｜｜DSML｜｜ invoke>
//   </｜｜DSML｜｜ calls>
// A parameter with string="true" is the text as written; string="false" is a JSON value (number, list, object, true...).
// The bars may be ASCII, doubled or full-width, with or without spaces, and the older form puts a ">" after them (`<|DSML|>invoke ...>`).

import { DSML_RE } from "../markers.js";
import { parseLoose } from "../json-scan.js";

const tagsOf = (text) => [...text.matchAll(/<\s*(\/?)\s*[|｜][\s|｜]*DSML[\s|｜]*[|｜]>?\s*([A-Za-z_]+)([^<>]*)>/g)].map((m) => ({
  close: m[1] === "/", word: m[2].toLowerCase(), attrs: Object.fromEntries([...m[3].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((a) => [a[1], a[2]])),
  start: m.index, end: m.index + m[0].length,
}));

function valueOf(raw, string) {
  // A string parameter is the text as written, minus the newline and indentation that
  // only exist because the tag was written on its own line. Inner lines stay untouched.
  if (string === "true") return raw.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
  const text = raw.trim();
  try { return JSON.parse(text); } catch { /* not strict JSON */ }
  try { return parseLoose(text); } catch { return text; }
}

export const dsml = {
  id: "dsml",
  recognises: (text) => DSML_RE.test(text),

  /** Every complete <invoke> in the text, in the order written. */
  parse(text) {
    const tags = tagsOf(text);
    const calls = [];
    let current = null;
    tags.forEach((tag, i) => {
      if (tag.word === "invoke") {
        if (!tag.close) current = { tool: tag.attrs.name || "", arguments: {} };
        else { if (current && current.tool) calls.push(current); current = null; }
      } else if (tag.word === "parameter" && !tag.close && current && tag.attrs.name) {
        current.arguments[tag.attrs.name] = valueOf(text.slice(tag.end, tags[i + 1] ? tags[i + 1].start : text.length), tag.attrs.string);
      }
    });
    return calls;
  },

  /** A call still being written: an <invoke> or the <calls> around it not closed yet, or a tag cut off in the middle. */
  isOpen(text) {
    const tags = tagsOf(text);
    const balance = (words) => tags.filter((t) => words.includes(t.word)).reduce((n, t) => n + (t.close ? -1 : 1), 0);
    const cut = text.lastIndexOf("<");
    return balance(["invoke"]) > 0 || balance(["calls", "tool_calls"]) > 0 || (cut > text.lastIndexOf(">") && DSML_RE.test(text.slice(cut)));
  },
};
