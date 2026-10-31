import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChipPainter } from "../src/ui/chip-painter.js";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

// The painter is exercised against real adapters on captured markup: the point of it is surviving what sites do to the DOM.
function setup(file, html, url) {
  const loaded = loadProvider(file, html, url);
  const events = [];
  const painter = createChipPainter({ document: loaded.document, provider: loaded.provider, diag: (event, data) => events.push([event, data]) });
  const turn = loaded.provider.lastAssistant();
  return { ...loaded, painter, turn, events };
}
const classic = () => setup("chatgpt.js", fixture("chatgpt-classic.html"), "https://chatgpt.com/c/test");
const chips = (el) => el.querySelectorAll(".zs-chip");

describe("chip painter on a ChatGPT turn", () => {
  test("a command chip appears once, in its phase, and the raw command block is hidden", () => {
    const { painter, turn } = classic();
    painter.toolBox(turn, "read_file", "run", "", false);
    assert.equal(chips(turn).length, 1);
    assert.ok(turn.querySelector(".zs-chip").classList.contains("run"));
    assert.ok(turn.querySelector(".zs-tool-hide"), "the JSON the model wrote is masked");
    assert.deepEqual([turn.dataset.zphase, turn.dataset.zloop], ["run", undefined]);
  });

  test("repainting moves it to the new phase without making a second chip", () => {
    const { painter, turn } = classic();
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "done", "", true);
    assert.equal(chips(turn).length, 1);
    assert.ok(turn.querySelector(".zs-chip").classList.contains("done"));
    assert.equal(turn.dataset.zloop, "1", "the loop owns it now");
  });

  test("every phase change is logged with who drove it, an unchanged phase is not", () => {
    const { painter, turn, events } = classic();
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "done", "", true);
    const phases = events.filter(([event]) => event === "chip.phase").map(([, data]) => [data.from, data.to, data.by]);
    assert.deepEqual(phases, [["(new)", "run", "sweep"], ["run", "done", "loop"]]);
  });

  test("a chip the site wiped is rebuilt from what the loop last said, and logged", () => {
    const { painter, turn, events } = classic();
    painter.toolBox(turn, "read_file", "done", "ok", true, "body text", "read");
    turn.querySelector(".zs-chip").remove();
    painter.ensureOwnedChip(turn);
    assert.equal(chips(turn).length, 1);
    assert.match(turn.querySelector(".zs-chip-tx").textContent, /read_file/);
    assert.ok(events.some(([event, data]) => event === "chip.rebuild" && data.chipGone));
  });

  test("an intact chip is left alone: no rebuild, no log", () => {
    const { painter, turn, events } = classic();
    painter.toolBox(turn, "read_file", "done", "", true);
    const before = turn.querySelector(".zs-chip");
    painter.ensureOwnedChip(turn);
    assert.equal(turn.querySelector(".zs-chip"), before);
    assert.ok(!events.some(([event]) => event === "chip.rebuild"));
  });

  test("a turn the loop never painted has nothing to rebuild", () => {
    const { painter, turn } = classic();
    painter.ensureOwnedChip(turn);
    assert.equal(chips(turn).length, 0);
  });

  test("a whole-turn chip (a result we injected) hides the turn and carries the chip as its first child", () => {
    const { painter, document } = classic();
    const user = document.querySelector('[data-message-author-role="user"]');
    painter.chip(user, { label: "read_file · result", category: "read", body: "text", phase: "result", cls: "result", whole: true });
    assert.ok(user.classList.contains("zs-hidden"));
    assert.equal(user.firstElementChild.className.includes("zs-chip"), true);
  });

  test("a missing turn is ignored", () => {
    const { painter } = classic();
    assert.doesNotThrow(() => painter.toolBox(null, "x", "run", "", false));
  });
});

describe("chip painter on a site whose turn element is re-rendered (chipAtItemLevel)", () => {
  test("Gemini: the chip sits at the turn root, where Angular's re-render of the content cannot wipe it", () => {
    const { painter, turn } = setup("gemini.js", fixture("sites/gemini.html"), "https://gemini.google.com/app/x");
    painter.toolBox(turn, "read_file", "run", "", false);
    assert.equal(turn.firstElementChild.className.includes("zs-chip"), true);
    turn.querySelector("model-response-content").replaceWith(document_createLike(turn, "model-response-content"));
    painter.toolBox(turn, "read_file", "done", "", false);
    assert.equal(chips(turn).length, 1, "still one chip after the content subtree was replaced");
  });
});

function document_createLike(el, tag) {
  return el.ownerDocument.createElement(tag);
}
