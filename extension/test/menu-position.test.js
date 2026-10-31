import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, applyMenuPlacement, viewportOf } from "../src/ui/menu-position.js";

const viewport = { width: 1000, height: 800 };
const place = (over) => computeMenuPlacement({ anchor: { left: 700, right: 800, top: 700, bottom: 740 }, menuWidth: 274, defaultWidth: 274, viewport, align: "right", roomAbove: 180, ...over });

describe("menu placement", () => {
  test("a bar at the bottom opens upwards, lined up with the anchor's right edge", () => {
    assert.deepEqual(place(), { left: 526, top: "auto", bottom: 106, maxHeight: 684 });
  });

  test("left alignment lines up with the anchor's left edge", () => {
    assert.equal(place({ align: "left" }).left, 700);
  });

  test("it never leaves the viewport horizontally", () => {
    assert.equal(place({ anchor: { left: 0, right: 20, top: 700, bottom: 740 } }).left, 8);
    assert.equal(place({ align: "left", anchor: { left: 990, right: 1000, top: 700, bottom: 740 } }).left, 1000 - 274 - 8);
  });

  test("a menu wider than the viewport is shrunk to fit", () => {
    const p = place({ viewport: { width: 200, height: 800 }, menuWidth: 500 });
    assert.equal(p.left, 8);
  });

  test("an unmeasured menu uses the default width", () => {
    assert.equal(place({ menuWidth: 0, defaultWidth: 220 }).left, 800 - 220);
  });

  test("with little room above and more below it opens downwards", () => {
    const p = place({ anchor: { left: 100, right: 200, top: 60, bottom: 100 } });
    assert.deepEqual(p, { left: 8, top: 106, bottom: "auto", maxHeight: 686 });
  });

  test("it opens upwards when there is simply more room above", () => {
    const p = place({ roomAbove: 10000, anchor: { left: 100, right: 200, top: 500, bottom: 540 } });
    assert.equal(p.top, "auto");
    assert.equal(p.maxHeight, 484);
  });

  test("the roomAbove threshold decides when a menu opens upwards (the two menus use 180 and 160)", () => {
    const anchor = { left: 100, right: 200, top: 190, bottom: 230 }; // 174px above after the margin
    assert.equal(place({ anchor, roomAbove: 180 }).top, 236, "174 < 180: opens downwards");
    assert.equal(place({ anchor, roomAbove: 160 }).top, "auto", "174 >= 160: opens upwards");
  });

  test("a menu that opens downwards keeps room beneath it and a minimum height", () => {
    const p = place({ anchor: { left: 100, right: 200, top: 10, bottom: 780 }, viewport: { width: 1000, height: 800 } });
    assert.equal(p.top, 692);
    assert.equal(p.maxHeight >= 100, true);
  });

  test("applyMenuPlacement writes pixel values and keeps 'auto'", () => {
    const style = {};
    applyMenuPlacement({ style }, { left: 5, top: "auto", bottom: 10, maxHeight: 300 });
    assert.deepEqual(style, { left: "5px", right: "auto", top: "auto", bottom: "10px", maxHeight: "300px" });
  });

  test("viewportOf prefers the document size and falls back to the window", () => {
    assert.deepEqual(viewportOf({ documentElement: { clientWidth: 900, clientHeight: 700 } }, { innerWidth: 1, innerHeight: 2 }), { width: 900, height: 700 });
    assert.deepEqual(viewportOf({ documentElement: { clientWidth: 0, clientHeight: 0 } }, { innerWidth: 1, innerHeight: 2 }), { width: 1, height: 2 });
  });
});
