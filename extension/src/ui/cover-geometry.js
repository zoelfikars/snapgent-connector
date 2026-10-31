// SPDX-License-Identifier: GPL-3.0-or-later
// Where the "Agent is working…" cover goes over the chat composer. Pure geometry; the DOM measuring
// (which ancestors clip, the composer's frame) is done by the caller and passed in as plain rectangles.
//
// A cover is position:fixed and re-placed every frame from a freshly measured rectangle, so the
// rectangle must never claim more than is really visible. Each rule below exists because a site
// once made the cover stick out of the composer.

const MIN_HEIGHT = 36;           // so the label is readable over a one-line composer
const DEFAULT_MAX_HEIGHT = 200;  // a growing editor must never turn the cover into a page-wide slab
const MIN_FRAME_OVERLAP = 40;    // clamp to the composer frame only if a usable width remains

/** @typedef {{ left: number, top: number, width: number, height: number }} Box */
const right = (box) => box.left + box.width;
const bottom = (box) => box.top + box.height;

/**
 * Intersect `box` with the nearest ancestor that clips each axis. The two axes are independent: the
 * ancestor that clips X is not always the one that clips Y. (Kimi's editor balloons to ~1500px inside a
 * container that caps the visible box; ChatGPT's editor widens past an overflow-x:hidden wrapper.)
 * @param {Box} box
 * @param {Array<{ box: Box, clipsX: boolean, clipsY: boolean }>} ancestors nearest first
 */
export function clipToAncestors(box, ancestors) {
  let current = box;
  let doneX = false;
  let doneY = false;
  for (const ancestor of ancestors) {
    if (doneX && doneY) break;
    if (!doneY && ancestor.clipsY) {
      doneY = true;
      const top = Math.max(current.top, ancestor.box.top);
      const low = Math.min(bottom(current), bottom(ancestor.box));
      if (low > top) current = { ...current, top, height: low - top };
    }
    if (!doneX && ancestor.clipsX) {
      doneX = true;
      const left = Math.max(current.left, ancestor.box.left);
      const high = Math.min(right(current), right(ancestor.box));
      if (high > left) current = { ...current, left, width: high - left };
    }
  }
  return current;
}

/**
 * Never extend past the composer card horizontally. A site that animates its composer lays out AFTER our
 * frame callback, so for the whole animation the cover trails one frame behind (ChatGPT's first send:
 * the card slides 29px left while the cover hung 28px past it). Only a frame that really wraps the
 * cover's centre counts, so a narrow frame can never shrink the cover.
 */
export function clampToFrame(box, frame) {
  if (!frame || frame.width <= 0) return box;
  const centre = box.left + box.width / 2;
  if (!(frame.left <= centre && right(frame) >= centre)) return box;
  const left = Math.max(box.left, frame.left);
  const high = Math.min(right(box), right(frame));
  return high - left > MIN_FRAME_OVERLAP ? { ...box, left, width: high - left } : box;
}

/**
 * The final rectangle: optionally bleed `pad` px on every side (Gemini's Quill keeps text near rounded
 * corners), shift the label by `offsetY`, enforce a minimum height centred on the editor's middle (so a
 * short textarea does not grow only downwards) and a hard maximum.
 */
export function sizeCover(box, { pad = 0, offsetY = 0, maxHeight = DEFAULT_MAX_HEIGHT }) {
  const height = Math.min(Math.max(box.height + pad * 2, MIN_HEIGHT), maxHeight);
  const centreY = box.top + box.height / 2 + offsetY;
  return { left: box.left - pad, top: centreY - height / 2, width: box.width + pad * 2, height };
}

/**
 * @param {{ target: Box, ancestors?: Array<{ box: Box, clipsX: boolean, clipsY: boolean }>, frame?: Box|null,
 *           pad?: number, offsetY?: number, maxHeight?: number }} input
 * @returns {Box}
 */
export function computeCoverRect({ target, ancestors = [], frame = null, pad, offsetY, maxHeight }) {
  return sizeCover(clampToFrame(clipToAncestors(target, ancestors), frame), { pad, offsetY, maxHeight });
}

const clips = (value) => value === "auto" || value === "scroll" || value === "hidden";
const boxOf = (rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

/**
 * Measure the nearest clipping ancestors of `node` (the DOM side of clipToAncestors). It runs every frame,
 * so it stops as soon as both axes have found a clipping ancestor instead of reading every level.
 */
export function measureClippingAncestors(node, doc, computedStyle, limit = 8) {
  const found = [];
  let foundX = false;
  let foundY = false;
  for (let a = node.parentElement, i = 0; a && a !== doc.body && i < limit; a = a.parentElement, i++) {
    const style = computedStyle(a);
    const clipsX = clips(style.overflowX);
    const clipsY = clips(style.overflowY);
    found.push({ box: boxOf(a.getBoundingClientRect()), clipsX, clipsY });
    foundX = foundX || clipsX;
    foundY = foundY || clipsY;
    if (foundX && foundY) break;
  }
  return found;
}

export { boxOf };
