// SPDX-License-Identifier: GPL-3.0-or-later
// Where the status bar sits on a chat page. Pure decisions and geometry; main.js measures the page and
// does the DOM work (inserting the bar, borrowing the composer's padding).
//
// Three ways to seat the bar, best first:
//   inline    a real node inside the composer, chosen by the site adapter (full width, never overlaps);
//   anchored  position:fixed hugging the top of an element, with that element's top padding reserved
//             (for composers owned by a framework such as Vue, which would swallow a node we insert);
//   floating  position:fixed just above the editor, centred, for sites with neither.
// While a bot check or a login/consent modal is on screen the bar steps aside entirely: a full-width
// transparent bar would silently eat clicks meant for the modal's buttons.

const WINDOW_MARGIN = 24;
export const BAR_MAX_WIDTH = 560;
export const BAR_GAP = 8;
const ANCHOR_PADDING_GAP = 6;
const DEFAULT_ANCHORED_HEIGHT = 34;
const DEFAULT_FLOATING_HEIGHT = 40;
const MIN_TOP = 4;
const PILL_GAP = 5;
const DEFAULT_PILL_HEIGHT = 20;

/** @returns {"hidden"|"inline"|"anchored"|"floating"} */
export function chooseBarMode({ obstructed, hasInlineMount, hasAnchor }) {
  if (obstructed) return "hidden";
  if (hasInlineMount) return "inline";
  if (hasAnchor) return "anchored";
  return "floating";
}

/**
 * Hug the top of `rect`. `paddingTop` is the strip to reserve on that element so the bar reads as in-flow.
 * @returns {{ left: number, top: number, width: number, paddingTop: number } | null} null when the anchor has no size
 */
export function anchoredGeometry(rect, barHeight) {
  if (!rect.width) return null;
  const height = barHeight || DEFAULT_ANCHORED_HEIGHT;
  return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), paddingTop: height + ANCHOR_PADDING_GAP };
}

/** Centre above `rect` (the editor), no wider than BAR_MAX_WIDTH. @returns {{left:number, top:number, width:number}|null} */
/**
 * Where the bar goes on a page with no known text box (a site that is not calibrated yet, or whose box is gone): centred
 * at the bottom of the window, so the user can always reach Calibrate and the menu.
 */
export function windowGeometry(viewport, barHeight) {
  const height = barHeight || DEFAULT_FLOATING_HEIGHT;
  const width = Math.max(0, Math.min(BAR_MAX_WIDTH, viewport.width - 2 * WINDOW_MARGIN));
  return {
    left: Math.round((viewport.width - width) / 2),
    top: Math.max(MIN_TOP, Math.round(viewport.height - height - WINDOW_MARGIN)),
    width,
  };
}

export function floatingGeometry(rect, barHeight) {
  if (!rect.width) return null;
  const width = Math.min(rect.width, BAR_MAX_WIDTH);
  const height = barHeight || DEFAULT_FLOATING_HEIGHT;
  return {
    left: Math.round(rect.left + (rect.width - width) / 2),
    top: Math.max(MIN_TOP, Math.round(rect.top - height - BAR_GAP)),
    width,
  };
}

/** The "unstable" pill floats just above the bar's left edge. @returns {{left:number, top:number}|null} null = hide it */
export function pillPosition(barRect, pillHeight) {
  if (!barRect || !barRect.width) return null;
  return { left: Math.round(barRect.left), top: Math.round(Math.max(MIN_TOP, barRect.top - (pillHeight || DEFAULT_PILL_HEIGHT) - PILL_GAP)) };
}
