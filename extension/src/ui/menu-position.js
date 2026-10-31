// SPDX-License-Identifier: GPL-3.0-or-later
// Where a popover menu goes relative to the button that opened it. Pure geometry: rectangles in,
// pixel numbers out. The menu opens ABOVE its anchor when there is room (the bar sits at the bottom of
// the page), otherwise below, and is kept inside the viewport.

const EDGE = 8;          // minimum gap to the viewport edge
const GAP = 6;           // gap between anchor and menu
const MIN_HEIGHT = 100;
const BELOW_RESERVE = 108; // keep this much room under a menu that opens downwards

/**
 * @param {{ anchor: {left: number, right: number, top: number, bottom: number},
 *           menuWidth: number,                      // measured width, or 0 when not laid out yet
 *           defaultWidth: number,                   // used when the menu has not been measured
 *           viewport: {width: number, height: number},
 *           align: "left"|"right",                  // which edge of the anchor the menu lines up with
 *           roomAbove: number }} input              // space above the anchor that is enough to open upwards
 * @returns {{ left: number, top: number|"auto", bottom: number|"auto", maxHeight: number }}
 */
export function computeMenuPlacement({ anchor, menuWidth, defaultWidth, viewport, align, roomAbove }) {
  const width = Math.min(menuWidth || defaultWidth, viewport.width - 2 * EDGE);
  const wanted = align === "right" ? anchor.right - width : anchor.left;
  const left = Math.round(Math.max(EDGE, Math.min(wanted, viewport.width - width - EDGE)));
  const spaceAbove = anchor.top - 2 * EDGE;
  if (spaceAbove >= roomAbove || spaceAbove >= viewport.height - anchor.bottom - 2 * EDGE) {
    return {
      left,
      top: "auto",
      bottom: Math.round(viewport.height - anchor.top + GAP),
      maxHeight: Math.max(MIN_HEIGHT, Math.min(spaceAbove, viewport.height - 2 * EDGE)),
    };
  }
  const top = Math.min(viewport.height - BELOW_RESERVE, anchor.bottom + GAP);
  return { left, top: Math.round(top), bottom: "auto", maxHeight: Math.max(MIN_HEIGHT, viewport.height - top - EDGE) };
}

/** Write a placement onto a (position: fixed) menu element. */
export function applyMenuPlacement(el, placement) {
  const px = (value) => (value === "auto" ? "auto" : `${value}px`);
  el.style.left = px(placement.left);
  el.style.right = "auto";
  el.style.top = px(placement.top);
  el.style.bottom = px(placement.bottom);
  el.style.maxHeight = px(placement.maxHeight);
}

/** Viewport size as the page sees it. */
export const viewportOf = (document, window) => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: document.documentElement.clientHeight || window.innerHeight,
});
