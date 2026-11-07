// SPDX-License-Identifier: GPL-3.0-or-later
// How big the tutorial's text is drawn. Pure: the saved value goes in, a whole number the dialog can use comes out.

export const TUTORIAL_MIN_SIZE = 10;
export const TUTORIAL_MAX_SIZE = 22;
export const TUTORIAL_DEFAULT_SIZE = 14;

// Anything that is not a number (nothing saved yet, a broken value) falls back to the default, and a real number is kept inside the
// range the A-/A+ buttons can reach.
export function clampTutorialSize(value) {
  const size = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof size !== "number" || !Number.isFinite(size)) return TUTORIAL_DEFAULT_SIZE;
  return Math.min(TUTORIAL_MAX_SIZE, Math.max(TUTORIAL_MIN_SIZE, Math.round(size)));
}
