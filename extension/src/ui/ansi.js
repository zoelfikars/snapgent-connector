// SPDX-License-Identifier: GPL-3.0-or-later
// Terminal text fed in as a stream of chunks with ANSI escapes (what a command prints), turned into
// whole lines of styled segments. Pure: `feed` is a state machine; `segmentHtml` and `lineHtml` render.
// Colours, bold/italic/underline, \r overwriting (progress bars) and \n. Cursor moves and other codes
// are ignored (their text is kept). An escape cut by the chunk end waits for its tail in the next chunk.

export const MAX_TEXT = 2000;   // a line longer than this is cut
const MAX_LINE_SEGMENTS = 3000; // a line kept open by a chatty progress bar also stays bounded

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function clampText(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}…`;
}

/** The CSS classes for one SGR state (a list of codes; the hex values are in overlay.css). */
export function classesOf(codes) {
  const classes = [];
  let fg = null;
  let bright = false;
  let bg = null;
  let bgBright = false;
  let bold = false;
  let italic = false;
  let underline = false;
  for (const code of codes) {
    if (code === 0) { fg = bg = null; bright = bgBright = bold = italic = underline = false; }
    else if (code === 1) bold = true;
    else if (code === 3) italic = true;
    else if (code === 4) underline = true;
    else if (code === 22) bold = false;
    else if (code === 23) italic = false;
    else if (code === 24) underline = false;
    else if (code >= 30 && code <= 37) { fg = code - 30; bright = false; }
    else if (code >= 90 && code <= 97) { fg = code - 90; bright = true; }
    else if (code === 39) fg = null;
    else if (code >= 40 && code <= 47) { bg = code - 40; bgBright = false; }
    else if (code >= 100 && code <= 107) { bg = code - 100; bgBright = true; }
    else if (code === 49) bg = null;
    // 256-colour and true colour are ignored: near every build tool uses the 16.
  }
  if (fg != null) classes.push(`zs-a-${bright ? "bright" : "fg"}${fg}`);
  if (bg != null) classes.push(`zs-a-${bgBright ? "brightbg" : "bg"}${bg}`);
  if (bold) classes.push("zs-a-bold");
  if (italic) classes.push("zs-a-italic");
  if (underline) classes.push("zs-a-under");
  return classes;
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One styled piece of output text. */
export function segmentHtml(text, codes) {
  const classes = classesOf(codes);
  const escaped = escapeHtml(clampText(text));
  return classes.length ? `<span class="${classes.join(" ")}">${escaped}</span>` : escaped;
}

/** A whole line (a list of segments) as HTML, `&nbsp;` for a blank line. */
export function lineHtml(segments) {
  if (!segments || !segments.length) return '<div class="zs-t-line">&nbsp;</div>';
  return `<div class="zs-t-line">${segments.map((segment) => segmentHtml(segment.text, segment.codes)).join("")}</div>`;
}

/** A parser state: the current (unfinished) line as segments, the codes in force, and a split escape. */
export function state() {
  return { line: [], codes: [], pending: "" };
}

/** Merge the next chunk of raw output; returns `{ lines, state }` (`lines` are the complete ones only). */
export function feed(state, text) {
  const result = {
    lines: [],
    state: { line: state.line, codes: state.codes, pending: state.pending || "" },
  };
  let index = 0;
  if (result.state.pending) { // the escape whose tail was missing last time
    const escape = readEscape(result.state.pending + text, 0);
    if (escape.size === 0) return result; // the tail still has not arrived
    if (escape.kind === "sgr") applySgr(result.state, escape.params);
    index = escape.size - result.state.pending.length;
    result.state.pending = "";
  }
  while (index < text.length) {
    const char = text[index];
    if (char === ESC) {
      const escape = readEscape(text, index);
      if (escape.size === 0) {
        result.state.pending = text.slice(index); // cut by the chunk end
        break;
      }
      if (escape.kind === "sgr") applySgr(result.state, escape.params);
      index += escape.size;
    } else if (char === "\n") {
      result.lines.push(result.state.line);
      result.state.line = [];
      index++;
    } else if (char === "\r") {
      result.state.line = []; // the progress-bar overwrite
      index++;
    } else {
      // A snapshot, not a reference: later codes change the current state, not the segments already placed.
      result.state.line.push({ text: char, codes: result.state.codes.slice() });
      index++;
    }
    result.state.line = result.state.line.slice(-MAX_LINE_SEGMENTS); // a runaway line stays bounded
  }
  return result;
}

function applySgr(state, params) {
  for (const code of params) {
    if (code === 0) state.codes = [];
    else state.codes.push(code);
  }
  if (state.codes.length > 64) state.codes = state.codes.slice(-64); // a runaway state stays small
}

/** The size and meaning of one escape starting at `i`; size 0 when it is cut before it ends. */
function readEscape(text, i) {
  if (text[i + 1] !== "[") {
    // Other escapes (OSC titles and the like): up to BEL, dropped when BEL never arrives.
    const end = text.indexOf(BEL, i + 1);
    if (end === -1) return { size: 0 };
    return { size: end - i + 1, kind: "other", params: [] };
  }
  let j = i + 2;
  while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
  if (j >= text.length) return { size: 0 };
  const params = text.slice(i + 2, j).split(";").map((piece) => parseInt(piece, 10)).filter((n) => Number.isFinite(n));
  return text[j] === "m" ? { size: j - i + 1, kind: "sgr", params: params.length ? params : [0] } : { size: j - i + 1, kind: "other", params };
}
