// SPDX-License-Identifier: GPL-3.0-or-later
// Decides whether the host page is light or dark, so the overlay can pick readable colours.
// Knows nothing about chips or the bar: it reads the page and toggles one class on <html>.

/**
 * The theme the site declares itself (class, data attribute or CSS color-scheme).
 * More reliable than luminance: many sites leave <html>/<body> transparent.
 * @param {Document} doc
 * @returns {"light"|"dark"|null} null when the page gives no explicit signal
 */
export function pageThemeHint(doc) {
  const de = doc.documentElement, b = doc.body;
  // Our own `zs-light` class must not count as the site's signal: `-` is a word boundary,
  // so it would match \blight\b and the page could never switch back to dark.
  const cls = (de.className + " " + (b ? b.className : "")).toLowerCase().replace(/\bzs-light\b/g, " ");
  if (/\bdark\b/.test(cls)) return "dark";
  if (/\blight\b/.test(cls)) return "light";
  const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                de.getAttribute("data-color-scheme") || "").toLowerCase();
  if (/dark/.test(attr)) return "dark";
  if (/light/.test(attr)) return "light";
  const cs = (doc.defaultView.getComputedStyle(de).colorScheme || "").toLowerCase();
  if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
  if (/light/.test(cs) && !/dark/.test(cs)) return "light";
  return null;
}

/**
 * Fallback only: the first opaque background colour going up from <body>.
 * @param {Document} doc
 * @returns {string}
 */
export function effectiveBg(doc) {
  const cs = (el) => doc.defaultView.getComputedStyle(el);
  let n = doc.body;
  while (n && n !== doc.documentElement) {
    const c = cs(n).backgroundColor;
    if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
    n = n.parentElement;
  }
  return cs(doc.documentElement).backgroundColor || "rgb(255,255,255)";
}

/**
 * True for a light page, false for a dark one, null when the colour cannot be read.
 * @param {Document} doc
 * @returns {boolean|null}
 */
export function isLightPage(doc) {
  const hint = pageThemeHint(doc);
  if (hint) return hint === "light";
  const m = (effectiveBg(doc).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (m.length < 3) return null;
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
}

/**
 * Mirror the page theme onto <html> as `.zs-light`.
 * @param {Document} doc
 */
export function applyTheme(doc) {
  const light = isLightPage(doc);
  if (light === null) return;
  doc.documentElement.classList.toggle("zs-light", light);
}
