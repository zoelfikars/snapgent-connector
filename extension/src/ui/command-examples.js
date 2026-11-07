// SPDX-License-Identifier: GPL-3.0-or-later
// "Command examples" popup, opened from the terminal: one card per available command with a JSON call to copy, or to put in the
// terminal's input. Text goes in with textContent only; the examples come ready-made from domain/tools/example-call.js.

import { closeButton, mountPopup } from "./popup.js";

const make = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === "button") node.type = "button";
  return node;
};

const SMALL = "zs-mcp-pop-btn zs-mcp-pop-btn-small";

function card(doc, example, { copy, use }) {
  const box = make(doc, "div", "zs-ex");
  const head = make(doc, "div", "zs-ex-head");
  head.appendChild(make(doc, "b", "zs-ex-name", example.name));
  if (example.description) head.appendChild(make(doc, "span", "zs-ex-desc", example.description));
  const foot = make(doc, "div", "zs-ex-foot");
  foot.appendChild(make(doc, "span", "zs-ex-opt", example.optional.length ? `Optional: ${example.optional.join(", ")}` : ""));
  const copyButton = make(doc, "button", `${SMALL} zs-ex-copy`, "Copy");
  const useButton = make(doc, "button", `${SMALL} zs-ex-use`, "Use");
  useButton.title = "Put it in the terminal's input";
  copyButton.addEventListener("click", async () => {
    let ok = false;
    try { ok = !!(await copy(example.json)); } catch { ok = false; }
    copyButton.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
  });
  useButton.addEventListener("click", () => use(example.json));
  foot.append(copyButton, useButton);
  box.append(head, make(doc, "pre", "zs-ex-json", example.json), foot);
  return box;
}

/**
 * @param {{ document: Document, examples: Array<{name: string, description: string, json: string, optional: string[]}>,
 *           copy: (text: string) => Promise<boolean>, onUse: (text: string) => void }} deps
 */
export function openCommandExamples({ document, examples, copy, onUse }) {
  const { pop, close } = mountPopup(document);
  pop.innerHTML = `<div class="zs-mcp-pop-card zs-pref-card" role="dialog" aria-label="Command examples"><div class="zs-mcp-pop-head"><span>Command examples</span>${closeButton}</div><div class="zs-mcp-pop-body"></div></div>`;
  pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
  const body = pop.querySelector(".zs-mcp-pop-body");
  const note = (text) => body.appendChild(make(document, "div", "zs-mcp-pop-note", text));
  if (!examples.length) {
    note("No commands are available yet. Connect the bridge and the MCP server first.");
  } else {
    note("Required parameters are filled with placeholders. Copy a call, or put it in the terminal's input and edit it there.");
    for (const example of examples) body.appendChild(card(document, example, { copy, use: (text) => { close(); onUse(text); } }));
  }
  return { close };
}
