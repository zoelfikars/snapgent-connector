// SPDX-License-Identifier: GPL-3.0-or-later
// Some chat pages draw a JSON code block as a collapsible tree with a Tree/Raw toggle. A collapsed node keeps none of its
// content in the page (only "5 items"), so the text of the reply is not JSON any more and the command in it cannot be read.
// The Raw view holds the whole text, so it is switched on before the reply is read.

const CHOSEN_CLASS = /active|selected|current/i;

const label = (button) => (button.textContent || "").trim().toLowerCase();
const isChosen = (button) =>
  CHOSEN_CLASS.test(String(button.className)) ||
  button.getAttribute("aria-pressed") === "true" ||
  button.getAttribute("aria-selected") === "true";

/**
 * Press every "Raw" button that sits beside a "Tree" button and is not the chosen one yet.
 * @returns {number} how many were pressed
 */
export function showRawViews(root) {
  if (!root || typeof root.querySelectorAll !== "function") return 0;
  let pressed = 0;
  for (const button of root.querySelectorAll("button")) {
    if (label(button) !== "raw" || isChosen(button) || button.closest("#zs-root")) continue;
    const toggle = button.parentElement;
    if (!toggle || ![...toggle.querySelectorAll("button")].some((other) => label(other) === "tree")) continue;
    try { button.click(); pressed++; } catch { /* a button that cannot be pressed: the tree text is read as it is */ }
  }
  return pressed;
}
