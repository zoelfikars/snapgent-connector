import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BAR_MAX_WIDTH, anchoredGeometry, chooseBarMode, floatingGeometry, pillPosition } from "../src/ui/bar-placement.js";

describe("chooseBarMode", () => {
  test("an overlay always wins: the bar steps aside so it cannot swallow clicks meant for a modal", () => {
    assert.equal(chooseBarMode({ obstructed: true, hasInlineMount: true, hasAnchor: true }), "hidden");
  });

  test("the adapter's inline mount beats an anchor, which beats floating", () => {
    assert.equal(chooseBarMode({ obstructed: false, hasInlineMount: true, hasAnchor: true }), "inline");
    assert.equal(chooseBarMode({ obstructed: false, hasInlineMount: false, hasAnchor: true }), "anchored");
    assert.equal(chooseBarMode({ obstructed: false, hasInlineMount: false, hasAnchor: false }), "floating");
  });
});

describe("anchoredGeometry", () => {
  test("hugs the anchor's top edge at full width and reserves the bar's height plus a gap", () => {
    assert.deepEqual(anchoredGeometry({ left: 100.4, top: 500.6, width: 700.2 }, 36), { left: 100, top: 501, width: 700, paddingTop: 42 });
  });

  test("an unmeasured bar assumes 34px", () => {
    assert.equal(anchoredGeometry({ left: 0, top: 0, width: 10 }, 0).paddingTop, 40);
  });

  test("an anchor with no width gives nothing to place (the bar hides)", () => {
    assert.equal(anchoredGeometry({ left: 0, top: 0, width: 0 }, 34), null);
  });
});

describe("floatingGeometry", () => {
  test("sits above the editor, centred, and no wider than the maximum", () => {
    const g = floatingGeometry({ left: 100, top: 600, width: 1000 }, 40);
    assert.equal(g.width, BAR_MAX_WIDTH);
    assert.equal(g.left, 100 + (1000 - 560) / 2);
    assert.equal(g.top, 600 - 40 - 8);
  });

  test("a narrow editor keeps its own width", () => {
    assert.equal(floatingGeometry({ left: 0, top: 300, width: 300 }, 40).width, 300);
  });

  test("it never goes off the top of the page", () => {
    assert.equal(floatingGeometry({ left: 0, top: 10, width: 300 }, 40).top, 4);
  });

  test("no width, nothing to place", () => {
    assert.equal(floatingGeometry({ left: 0, top: 0, width: 0 }, 40), null);
  });
});

describe("pillPosition", () => {
  test("above the bar's left edge, never off the top", () => {
    assert.deepEqual(pillPosition({ left: 50.4, top: 400, width: 600 }, 22), { left: 50, top: 373 });
    assert.equal(pillPosition({ left: 0, top: 10, width: 600 }, 22).top, 4);
  });

  test("a hidden or zero-width bar hides the pill", () => {
    assert.equal(pillPosition({ left: 0, top: 0, width: 0 }, 20), null);
    assert.equal(pillPosition(null, 20), null);
  });
});
