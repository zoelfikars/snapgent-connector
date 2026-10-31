// SPDX-License-Identifier: GPL-3.0-or-later
// Draws one tool chip: header (icon, label, detail) plus an optional expandable body.
// Knows nothing about where the chip sits on the page or what the loop is doing.

import { CHEVRON, iconFor } from "./chip-icons.js";

/**
 * @typedef {Object} ChipOpts
 * @property {string} label
 * @property {string} [detail]
 * @property {string} [body]       Expandable text; no body means no chevron.
 * @property {string} [category]   Picks the icon and the colour theme.
 * @property {string} [phase]      run | err | done | result | sys | remind | idle
 * @property {string} [cls]
 * @property {boolean} [whole]
 */

/** What the chip would look like. Equal signatures mean "do not touch the DOM". */
export function chipSignature(opts) {
  const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
  return `${category}|${phase}|${cls || ""}|${whole ? 1 : 0}|${label}|${detail}|${body ? body.length : 0}`;
}

/**
 * Create the chip element, or update the one passed in. The inner markup is rebuilt only when the
 * signature changes: while a command streams we are called on nearly every sweep, and re-creating
 * the spinner each time would restart its CSS animation and make it look frozen.
 * @param {Document} doc
 * @param {HTMLElement|null} chip existing chip, if any
 * @param {ChipOpts} opts
 * @returns {HTMLElement}
 */
export function paintChip(doc, chip, opts) {
  const { label, detail = "", body = "", category = "tool", phase, cls } = opts;
  const hasBody = !!body;
  const sig = chipSignature(opts);
  const el = chip || doc.createElement("div");
  if (el.dataset.csig === sig) return el;

  el.dataset.csig = sig;
  el.className = `zs-chip cat-${category} ${cls || ""}`;
  el.innerHTML =
    `<div class="zs-chip-head">` +
      `<span class="zs-chip-ic">${iconFor(category, phase)}</span>` +
      `<span class="zs-chip-tx"></span>` +
      `<span class="zs-chip-dt"></span>` +
      (hasBody ? `<span class="zs-chip-cv">${CHEVRON}</span>` : "") +
    `</div>` +
    (hasBody ? `<div class="zs-chip-body"><pre></pre></div>` : "");
  // Text goes in as text, never as markup: labels and bodies come from the model and from tools.
  el.querySelector(".zs-chip-tx").textContent = label;
  if (detail) el.querySelector(".zs-chip-dt").textContent = detail;
  if (hasBody) {
    el.querySelector(".zs-chip-body pre").textContent = body;
    const head = el.querySelector(".zs-chip-head");
    head.style.cursor = "pointer";
    head.onclick = () => el.classList.toggle("open");
  }
  return el;
}
