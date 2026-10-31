// SPDX-License-Identifier: GPL-3.0-or-later
// String-aware JSON scanning helpers. No knowledge of snapgentV3 commands.

// String-aware matching-brace finder: index of the "}" that closes the "{" at
// `start`, SKIPPING braces inside JSON string literals (escaped quotes handled).
// A naive depth counter miscounts the braces embedded in code passed as a string
// value (e.g. multi_edit's edits / a Lua snippet), grabs the wrong end, and makes
// JSON.parse fail - which silently dropped the command, so the tool never ran and
// the turn was treated as a plain-text answer. Returns -1 if unbalanced.
export function matchBrace(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return i; }
  }
  return -1;
}

// JSON.parse with a fallback for RAW control characters inside string
// literals (tab/newline/CR). Models sometimes emit a literal TAB instead of
// \t inside a command's string value (seen live on Gemini in a big
// multi_edit); strict JSON rejects it, the parse failed silently and the
// command was never executed. The fallback walks the text string-aware and
// escapes those characters ONLY inside string literals, then re-parses.
export function parseLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch (e0) {
    let out = "", inStr = false, esc = false;
    for (const c of raw) {
      if (inStr) {
        if (esc) { esc = false; out += c; continue; }
        if (c === "\\") { esc = true; out += c; continue; }
        if (c === '"') { inStr = false; out += c; continue; }
        if (c === "\t") { out += "\\t"; continue; }
        if (c === "\n") { out += "\\n"; continue; }
        if (c === "\r") { out += "\\r"; continue; }
        out += c;
        continue;
      }
      if (c === '"') inStr = true;
      out += c;
    }
    return JSON.parse(out); // may still throw - callers catch
  }
}

export function extractJson(raw) {
  raw = raw.trim().replace(/^(?:json|JSON)\s*/, "");
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const s = raw.indexOf("{");
  if (s === -1) return null;
  const e = matchBrace(raw, s);            // string-aware: not the last "}" in code
  if (e === -1) return null;
  try {
    return parseLoose(raw.slice(s, e + 1));
  } catch {
    return null;
  }
}
