// SPDX-License-Identifier: GPL-3.0-or-later
// "Tutorial" popup: the tutorial written in Markdown, drawn with the same card as the other settings popups, with a switch between the
// languages it was written in. Everything is built with DOM calls and textContent, so nothing the tutorial says can become markup;
// an image is shown only when it is an embedded image.

import { TUTORIAL_LANGUAGES } from "../domain/tutorial/language.js";
import { parseInline, parseTutorial } from "../domain/tutorial/parse.js";
import { closeButton, mountPopup } from "./popup.js";

function inline(doc, parent, text) {
  for (const part of parseInline(text)) {
    if (part.t === "text") { parent.appendChild(doc.createTextNode(part.v)); continue; }
    const el = doc.createElement(part.t === "b" ? "b" : "code");
    el.textContent = part.v;
    parent.appendChild(el);
  }
}

const note = (doc, text) => {
  const el = doc.createElement("div");
  el.className = "zs-mcp-pop-note";
  el.textContent = text;
  return el;
};

// A side the tutorial did not size is left alone, so the browser keeps the picture's proportions.
function sized(img, block) {
  for (const key of ["width", "height"]) {
    if (block[key]) img.style[key] = block[key].endsWith("%") ? block[key] : `${block[key]}px`;
  }
}

function blockNode(doc, block, images) {
  if (block.type === "heading") {
    const el = doc.createElement(`h${Math.min(block.level + 2, 5)}`);
    inline(doc, el, block.text);
    return el;
  }
  if (block.type === "paragraph") {
    const el = doc.createElement("p");
    inline(doc, el, block.text);
    return el;
  }
  if (block.type === "list") {
    const el = doc.createElement(block.ordered ? "ol" : "ul");
    for (const item of block.items) {
      const li = doc.createElement("li");
      inline(doc, li, item);
      el.appendChild(li);
    }
    return el;
  }
  if (block.type === "code") {
    const el = doc.createElement("pre");
    el.textContent = block.text;
    return el;
  }
  const src = images[block.name];
  if (typeof src !== "string" || !src.startsWith("data:image/")) return note(doc, `[image missing: ${block.name}]`);
  const img = doc.createElement("img");
  img.src = src;
  img.alt = block.name;
  sized(img, block);
  return img;
}

/** @param {{ document: Document, texts: Record<string, string>, images?: Record<string, string>, lang?: string, onLang?: (lang: string) => void }} deps */
export function openTutorial({ document, texts, images = {}, lang, onLang = () => {} }) {
  const { pop, close } = mountPopup(document);
  const buttons = TUTORIAL_LANGUAGES.map((code) => `<button type="button" class="zs-mcp-pop-btn zs-mcp-pop-btn-small" data-lang="${code}" aria-pressed="false">${code.toUpperCase()}</button>`).join("");
  pop.innerHTML = `<div class="zs-mcp-pop-card zs-pref-card" role="dialog" aria-label="Tutorial"><div class="zs-mcp-pop-head"><span>Tutorial</span><span class="zs-tut-lang">${buttons}</span>${closeButton}</div><div class="zs-mcp-pop-body zs-tut"></div></div>`;
  pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
  const body = pop.querySelector(".zs-tut");
  let current = TUTORIAL_LANGUAGES.includes(lang) ? lang : TUTORIAL_LANGUAGES[0];

  function render() {
    body.textContent = "";
    pop.querySelectorAll("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === current)));
    const blocks = parseTutorial((texts || {})[current]);
    if (!blocks.length) body.appendChild(note(document, "No tutorial has been written yet."));
    for (const block of blocks) body.appendChild(blockNode(document, block, images));
  }

  pop.querySelectorAll("[data-lang]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.lang === current) return;
    current = button.dataset.lang;
    onLang(current);
    render();
  }));
  render();
  return { close };
}
