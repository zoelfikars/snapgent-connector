import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clampToFrame, clipToAncestors, computeCoverRect, measureClippingAncestors, sizeCover } from "../src/ui/cover-geometry.js";

const box = (left, top, width, height) => ({ left, top, width, height });

describe("clipToAncestors", () => {
  test("a ballooned editor is cut to the visible band of the ancestor that clips Y (Kimi)", () => {
    const editor = box(100, 100, 600, 1500);
    const container = { box: box(90, 400, 620, 120), clipsX: false, clipsY: true };
    assert.deepEqual(clipToAncestors(editor, [container]), box(100, 400, 600, 120));
  });

  test("an editor wider than its overflow-x wrapper is cut horizontally (ChatGPT)", () => {
    const editor = box(100, 500, 900, 60);
    const wrapper = { box: box(120, 480, 600, 100), clipsX: true, clipsY: false };
    assert.deepEqual(clipToAncestors(editor, [wrapper]), box(120, 500, 600, 60));
  });

  test("each axis uses its own nearest clipping ancestor, and stops once both are found", () => {
    const editor = box(0, 0, 1000, 1000);
    const ancestors = [
      { box: box(10, 10, 500, 2000), clipsX: true, clipsY: false },
      { box: box(0, 50, 2000, 300), clipsX: false, clipsY: true },
      { box: box(400, 400, 10, 10), clipsX: true, clipsY: true }, // never reached
    ];
    assert.deepEqual(clipToAncestors(editor, ancestors), box(10, 50, 500, 300));
  });

  test("an ancestor that does not overlap is ignored rather than producing an empty box", () => {
    const editor = box(100, 100, 200, 50);
    const away = { box: box(0, 500, 50, 50), clipsX: true, clipsY: true };
    assert.deepEqual(clipToAncestors(editor, [away]), editor);
  });

  test("ancestors that clip nothing change nothing", () => {
    const editor = box(1, 2, 3, 4);
    assert.deepEqual(clipToAncestors(editor, [{ box: box(0, 0, 9, 9), clipsX: false, clipsY: false }]), editor);
    assert.deepEqual(clipToAncestors(editor, []), editor);
  });
});

describe("clampToFrame", () => {
  test("a cover that trails an animating composer is pulled back inside the card", () => {
    const cover = box(100, 0, 700, 60);   // sticks out 28px past the card's right edge
    assert.deepEqual(clampToFrame(cover, box(80, 0, 692, 80)), box(100, 0, 672, 60));
  });

  test("a frame that does not wrap the cover's centre is ignored (it could only shrink it)", () => {
    const cover = box(100, 0, 700, 60);
    assert.deepEqual(clampToFrame(cover, box(0, 0, 150, 80)), cover);
  });

  test("no frame, or a zero-width one, changes nothing", () => {
    const cover = box(0, 0, 100, 10);
    assert.equal(clampToFrame(cover, null), cover);
    assert.equal(clampToFrame(cover, box(0, 0, 0, 10)), cover);
  });

  test("a clamp that would leave a sliver is refused", () => {
    const cover = box(0, 0, 100, 10);
    assert.deepEqual(clampToFrame(cover, box(60, 0, 80, 10)), cover);
  });
});

describe("sizeCover", () => {
  test("a one-line composer gets the minimum height, centred on the editor's middle", () => {
    assert.deepEqual(sizeCover(box(10, 100, 300, 20), {}), box(10, 92, 300, 36));
  });

  test("a tall composer keeps its own height", () => {
    assert.deepEqual(sizeCover(box(10, 100, 300, 120), {}), box(10, 100, 300, 120));
  });

  test("the height ceiling stops a runaway editor from becoming a page-wide slab", () => {
    assert.equal(sizeCover(box(0, 0, 300, 5000), {}).height, 200);
    assert.equal(sizeCover(box(0, 0, 300, 5000), { maxHeight: 320 }).height, 320);
  });

  test("pad bleeds on every side and offsetY moves the whole cover", () => {
    assert.deepEqual(sizeCover(box(50, 100, 300, 100), { pad: 6, offsetY: -4 }), box(44, 90, 312, 112));
  });
});

describe("computeCoverRect", () => {
  test("applies clip, then frame, then sizing", () => {
    const rect = computeCoverRect({
      target: box(100, 100, 900, 1500),
      ancestors: [{ box: box(90, 400, 700, 120), clipsX: true, clipsY: true }],
      frame: box(95, 380, 600, 160),
    });
    assert.deepEqual(rect, box(100, 400, 595, 120));
  });
});

describe("measureClippingAncestors", () => {
  test("walks up to the body, at most `limit` levels, reading each ancestor's overflow", () => {
    const body = {};
    const mk = (parentElement, overflowX, overflowY) => ({ parentElement, overflowX, overflowY, getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4, right: 4, bottom: 6 }) });
    const outer = mk({ ...body }, "visible", "auto");
    const inner = mk(outer, "hidden", "visible");
    const node = { parentElement: inner };
    const doc = { body: outer.parentElement };
    const found = measureClippingAncestors(node, doc, (el) => ({ overflowX: el.overflowX, overflowY: el.overflowY }));
    assert.deepEqual(found.map((a) => [a.clipsX, a.clipsY]), [[true, false], [false, true]]);
    assert.deepEqual(found[0].box, box(1, 2, 3, 4));
    assert.equal(measureClippingAncestors(node, doc, () => ({}), 1).length, 1);
    let reads = 0;
    const both = { overflowX: "hidden", overflowY: "hidden" };
    measureClippingAncestors(node, doc, () => { reads++; return both; });
    assert.equal(reads, 1, "stops at the first ancestor that clips both axes");
  });
});
