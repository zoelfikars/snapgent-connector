// SPDX-License-Identifier: GPL-3.0-or-later
// The shared shell of the settings popups: one at a time, closes on a click outside the card.

const POPUP_ID = "zs-mcp-pop";

/** @returns {{ pop: HTMLElement, close: () => void }} the mounted popup root and a function that removes it */
export function mountPopup(document, { onClose = () => {} } = {}) {
  const old = document.getElementById(POPUP_ID);
  if (old) old.remove();
  const pop = document.createElement("div");
  pop.id = POPUP_ID;
  const close = () => { pop.remove(); onClose(); };
  pop.addEventListener("click", (event) => { if (event.target === pop) close(); });
  document.documentElement.appendChild(pop);
  return { pop, close };
}

export const closeButton = '<button class="zs-mcp-pop-close" aria-label="Close">&#10005;</button>';
