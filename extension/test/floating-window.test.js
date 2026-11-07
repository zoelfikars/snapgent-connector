import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFloatingWindow } from "../src/ui/floating-window.js";

describe("floating window resize", () => {
  function setup() {
    const { window } = new JSDOM("<!doctype html><body></body>");
    Object.defineProperty(window.document.documentElement, "clientWidth", { value: 1000, configurable: true });
    Object.defineProperty(window.document.documentElement, "clientHeight", { value: 800, configurable: true });
    const win = createFloatingWindow({ document: window.document, title: "Files" });
    win.root.getBoundingClientRect = () => ({ left: 100, right: 500, top: 10, width: 400, height: 300 });
    const grip = win.root.querySelector(".zs-fw-grip");
    const fire = (type, x, y) => grip.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), { clientX: x, clientY: y }));
    return { win, fire };
  }

  test("the grip is the bottom-left corner: dragging left widens, dragging down makes it taller, the right and top edges stay", () => {
    const { win, fire } = setup();
    fire("pointerdown", 100, 310);
    fire("pointermove", 50, 360);
    assert.equal(win.root.style.width, "450px");
    assert.equal(win.root.style.height, "350px");
    assert.equal(win.root.style.right, "500px");
    assert.equal(win.root.style.left, "auto");
    assert.equal(win.root.style.top, "10px");
    fire("pointerup", 50, 360);
    fire("pointermove", 0, 0);
    assert.equal(win.root.style.width, "450px", "nothing changes after the drag ended");
  });

  test("it never grows past the window's edges nor shrinks below its minimum", () => {
    const { win, fire } = setup();
    fire("pointerdown", 100, 310);
    fire("pointermove", -5000, 9000);
    assert.equal(win.root.style.width, "500px", "the left edge stops at the page's left");
    assert.equal(win.root.style.height, "790px", "the bottom stops at the page's bottom");
    fire("pointermove", 5000, -5000);
    assert.equal(win.root.style.width, "320px");
    assert.equal(win.root.style.height, "220px");
  });
});
