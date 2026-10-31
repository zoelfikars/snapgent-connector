// SPDX-License-Identifier: GPL-3.0-or-later
// Works out the solid colour that visually matches what sits behind the input cover.
// The cover must hide the typed text, so it cannot be translucent; but a composer whose own
// surface is translucent (Meta: rgba(56,56,56,0.8) over a dark page) looks lighter than the bare
// page. So the background layers are flattened (alpha compositing) into one opaque colour.
// Knows nothing about the cover element or where it sits.

/**
 * Parse a computed rgb()/rgba() colour.
 * @param {string} c
 * @returns {{r:number,g:number,b:number,a:number}|null} null for transparent or unparseable
 */
export function parseColor(c) {
  if (!c || c === "transparent") return null;
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
}

/**
 * Source-over compositing of a (possibly translucent) foreground onto an opaque background.
 * @param {{r:number,g:number,b:number,a:number}} fg
 * @param {{r:number,g:number,b:number,a:number}} bg
 */
export function blendOver(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/**
 * A fully opaque colour matching what is visually behind `el`.
 * @param {Document} doc
 * @param {Element} el
 * @returns {string} "rgb(r, g, b)"
 */
export function opaqueBg(doc, el) {
  const cs = (n) => doc.defaultView.getComputedStyle(n);
  const layers = [];
  let n = el;
  while (n && n !== doc.documentElement) {
    const c = parseColor(cs(n).backgroundColor);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 0.999) break; // opaque base reached: nothing behind matters
    }
    n = n.parentElement;
  }
  // Guarantee an opaque base at the bottom of the stack.
  if (!layers.length || layers[layers.length - 1].a < 0.999) {
    // A transparent <body> parses as alpha 0; forcing it opaque would paint the cover black.
    const bodyBg = doc.body && parseColor(cs(doc.body).backgroundColor);
    const base = bodyBg && bodyBg.a > 0 ? bodyBg : { r: 255, g: 255, b: 255, a: 1 };
    layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
  }
  // Collected top-most first, so composite from the opaque base (last) upward.
  let out = layers[layers.length - 1];
  for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
  return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
}
