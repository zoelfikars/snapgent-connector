import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseColor, blendOver, opaqueBg } from "../src/ui/cover-color.js";

const page = (html = "") =>
  new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;

describe("parseColor", () => {
  test("reads rgb and rgba", () => {
    assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
    assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  });

  test("transparent, empty and unparseable give null", () => {
    assert.equal(parseColor("transparent"), null);
    assert.equal(parseColor(""), null);
    assert.equal(parseColor(undefined), null);
    assert.equal(parseColor("red"), null);
  });
});

describe("blendOver", () => {
  test("an opaque foreground replaces the background", () => {
    assert.deepEqual(blendOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }),
      { r: 10, g: 20, b: 30, a: 1 });
  });

  test("a half-transparent foreground mixes evenly", () => {
    assert.deepEqual(blendOver({ r: 100, g: 0, b: 50, a: 0.5 }, { r: 0, g: 100, b: 50, a: 1 }),
      { r: 50, g: 50, b: 50, a: 1 });
  });
});

describe("opaqueBg", () => {
  test("an opaque element gives its own colour", () => {
    const d = page('<div id="x"></div>');
    const x = d.getElementById("x");
    x.style.backgroundColor = "rgb(10, 20, 30)";
    assert.equal(opaqueBg(d, x), "rgb(10, 20, 30)");
  });

  test("a translucent surface is flattened onto the page behind it (the Meta case)", () => {
    const d = page('<div id="x"></div>');
    d.body.style.backgroundColor = "rgb(24, 24, 25)";
    const x = d.getElementById("x");
    x.style.backgroundColor = "rgba(56, 56, 56, 0.8)";
    assert.equal(opaqueBg(d, x), "rgb(50, 50, 50)");
  });

  test("layers stack: translucent card over translucent wrapper over the body", () => {
    const d = page('<div id="w"><div id="x"></div></div>');
    d.body.style.backgroundColor = "rgb(0, 0, 0)";
    d.getElementById("w").style.backgroundColor = "rgba(100, 100, 100, 0.5)";
    const x = d.getElementById("x");
    x.style.backgroundColor = "rgba(200, 200, 200, 0.5)";
    // wrapper over body = 50; card over that = 125
    assert.equal(opaqueBg(d, x), "rgb(125, 125, 125)");
  });

  test("stops at the first opaque ancestor", () => {
    const d = page('<div id="w"><div id="x"></div></div>');
    d.body.style.backgroundColor = "rgb(255, 0, 0)";
    d.getElementById("w").style.backgroundColor = "rgb(0, 0, 255)";
    assert.equal(opaqueBg(d, d.getElementById("x")), "rgb(0, 0, 255)");
  });

  test("with no background anywhere it falls back to white", () => {
    const d = page('<div id="x"></div>');
    assert.equal(opaqueBg(d, d.getElementById("x")), "rgb(255, 255, 255)");
  });
});
