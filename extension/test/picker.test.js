import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPicker } from "../src/ui/picker.js";
import { pageWith } from "./support/jsdom-provider.js";

function setup(options = {}) {
  const { window, document } = pageWith(`<body><button id="site">site</button><div id="panel"><button id="ui">ui</button></div><p id="text"><span id="inner">hello</span></p></body>`);
  const picker = createPicker({ document, trusted: options.trusted || (() => true) });
  const picked = [];
  const hovered = [];
  const reached = [];
  document.getElementById("site").addEventListener("click", () => reached.push("site click"));
  document.getElementById("site").addEventListener("mousedown", () => reached.push("site mousedown"));
  const stop = picker.start({
    ignore: document.getElementById("panel"), refine: options.refine, onPick: (el) => picked.push(el.id), onHover: (el) => hovered.push(el && el.id), onCancel: () => picked.push("cancelled"),
  });
  const fire = (id, type, init = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    document.getElementById(id).dispatchEvent(event);
    return event;
  };
  return { window, document, picked, hovered, reached, stop, fire };
}

describe("picker", () => {
  test("a click chooses the element under it and the page never sees the click", () => {
    const { fire, picked, reached } = setup();
    const event = fire("site", "click");
    fire("site", "mousedown");
    assert.deepEqual(picked, ["site"]);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(reached, [], "neither the click nor the press reached the page");
  });

  test("hovering reports the element, and null over our own panel", () => {
    const { fire, hovered } = setup();
    fire("inner", "mousemove");
    fire("ui", "mousemove");
    assert.deepEqual(hovered, ["inner", null]);
  });

  test("clicks inside our own panel are left alone", () => {
    const { fire, picked } = setup();
    const event = fire("ui", "click");
    assert.deepEqual(picked, []);
    assert.equal(event.defaultPrevented, false);
  });

  test("a click the page fabricated chooses nothing (it is swallowed)", () => {
    const { fire, picked, reached } = setup({ trusted: () => false });
    const event = fire("site", "click");
    assert.deepEqual(picked, []);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(reached, []);
  });

  test("refine lets the step choose what a click means (a span inside a button is the button)", () => {
    const { fire, picked } = setup({ refine: (el) => el.closest("p") || el });
    fire("inner", "click");
    assert.deepEqual(picked, ["text"]);
  });

  test("Escape cancels, but only a genuine Escape", () => {
    const { document, picked, window } = setup();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.deepEqual(picked, []);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.deepEqual(picked, ["cancelled"]);
    const forged = setup({ trusted: () => false });
    forged.document.dispatchEvent(new forged.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.deepEqual(forged.picked, []);
  });

  test("stopping gives the page its clicks back", () => {
    const { fire, picked, reached, stop, hovered } = setup();
    stop();
    fire("site", "click");
    assert.deepEqual(picked, []);
    assert.deepEqual(reached, ["site click"]);
    assert.equal(hovered.at(-1), null, "the highlight is cleared");
  });

  test("by default only a genuine (isTrusted) click counts", () => {
    const { window, document } = pageWith(`<body><button id="b">b</button></body>`);
    const picked = [];
    createPicker({ document }).start({ onPick: (el) => picked.push(el.id) });
    document.getElementById("b").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.deepEqual(picked, [], "a dispatched event is never trusted");
  });

  test("the ignored area can be a test instead of one element", () => {
    const { window, document } = pageWith(`<body><button id="a">a</button><div class="mine"><button id="b">b</button></div></body>`);
    const picked = [];
    createPicker({ document, trusted: () => true }).start({ ignore: (target) => !!target.closest(".mine"), onPick: (el) => picked.push(el.id) });
    for (const id of ["a", "b"]) document.getElementById(id).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.deepEqual(picked, ["a"]);
  });
});
