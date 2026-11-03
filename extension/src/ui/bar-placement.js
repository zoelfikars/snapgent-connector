// SPDX-License-Identifier: GPL-3.0-or-later
// Where the control bar sits: in one of two corners of the window (bottom right or top right), beside a small
// button that shows or hides it. It never attaches to the site's text box, so nothing about a site's layout can
// squeeze, cover or hide it. Pure geometry: rectangles in, pixel numbers out.

export const BAR_WIDTH = 210;
const MARGIN = 16;
const TOGGLE = 34;       // the show/hide button's size
const TOGGLE_GAP = 8;
const MIN_HEIGHT = 40;

/** A stored corner, or the default when it is not one of the two. @returns {"bottom"|"top"} */
export const cornerOf = (value) => (value === "top" ? "top" : "bottom");

/** The show/hide button, in the right-hand corner. @returns {{ left: number, top: number }} */
export function toggleGeometry(viewport, corner) {
  return {
    left: Math.round(viewport.width - TOGGLE - MARGIN),
    top: corner === "top" ? MARGIN : Math.round(viewport.height - TOGGLE - MARGIN),
  };
}

/**
 * The Stop button that stands in for the hidden bar: right on top of the show/hide button (bottom corner), or right
 * under it (top corner), its right edge in line with the button's.
 * @returns {{ left: number, top: number }}
 */
export function floatingStopGeometry(viewport, size, corner) {
  const t = toggleGeometry(viewport, corner);
  const height = size.height || 32;
  return {
    left: Math.round(viewport.width - MARGIN - (size.width || 90)),
    top: corner === "top" ? t.top + TOGGLE + TOGGLE_GAP : Math.max(4, t.top - TOGGLE_GAP - height),
  };
}

/**
 * The bar, a narrow column above the button (bottom corner) or below it (top corner), its right edge in line with the button's.
 * @returns {{ left: number, top: number, maxHeight: number }}
 */
export function barGeometry(viewport, barSize, corner) {
  const width = barSize.width || BAR_WIDTH;
  const height = barSize.height || MIN_HEIGHT;
  const maxHeight = Math.max(MIN_HEIGHT, viewport.height - 2 * MARGIN - TOGGLE - TOGGLE_GAP);
  const shown = Math.min(height, maxHeight);
  return {
    left: Math.round(viewport.width - MARGIN - width),
    top: corner === "top" ? MARGIN + TOGGLE + TOGGLE_GAP : Math.round(viewport.height - MARGIN - TOGGLE - TOGGLE_GAP - shown),
    maxHeight,
  };
}

