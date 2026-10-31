import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChipPainter } from "../src/ui/chip-painter.js";
import { pageWith } from "./support/jsdom-provider.js";

// A minimal stand-in for the page-specific part: where the raw command block is and how it is hidden. The painter is
// exercised on a small page so that what it guarantees (one chip, in place, rebuilt after the site wipes it) is what is tested.
function setup({ atItemLevel = false } = {}) {
  const { document } = pageWith(`<body>
    <div id="user"><div>hello</div></div>
    <div id="turn"><div class="reply"><pre><code>{"command":"read_file","params":{"path":"a.js"}}</code></pre></div></div>
  </body>`);
  const turn = document.getElementById("turn");
  const provider = {
    chipAtItemLevel: atItemLevel,
    findToolBlockSpot(item) {
      const block = item.querySelector("pre");
      if (!block) return null;
      block.classList.add("zs-tool-hide");
      return { parent: block.parentElement, ref: block };
    },
  };
  const events = [];
  const painter = createChipPainter({ document, provider, diag: (event, data) => events.push([event, data]) });
  return { document, painter, turn, events };
}
const chips = (el) => el.querySelectorAll(".zs-chip");

describe("chip painter", () => {
  test("a command chip appears once, in its phase, and the raw command block is hidden", () => {
    const { painter, turn } = setup();
    painter.toolBox(turn, "read_file", "run", "", false);
    assert.equal(chips(turn).length, 1);
    assert.ok(turn.querySelector(".zs-chip").classList.contains("run"));
    assert.ok(turn.querySelector(".zs-tool-hide"), "the JSON the model wrote is masked");
    assert.deepEqual([turn.dataset.zphase, turn.dataset.zloop], ["run", undefined]);
  });

  test("repainting moves it to the new phase without making a second chip", () => {
    const { painter, turn } = setup();
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "done", "", true);
    assert.equal(chips(turn).length, 1);
    assert.ok(turn.querySelector(".zs-chip").classList.contains("done"));
    assert.equal(turn.dataset.zloop, "1", "the loop owns it now");
  });

  test("every phase change is logged with who drove it, an unchanged phase is not", () => {
    const { painter, turn, events } = setup();
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "run", "", false);
    painter.toolBox(turn, "read_file", "done", "", true);
    const phases = events.filter(([event]) => event === "chip.phase").map(([, data]) => [data.from, data.to, data.by]);
    assert.deepEqual(phases, [["(new)", "run", "sweep"], ["run", "done", "loop"]]);
  });

  test("a chip the site wiped is rebuilt from what the loop last said, and logged", () => {
    const { painter, turn, events } = setup();
    painter.toolBox(turn, "read_file", "done", "ok", true, "body text", "read");
    turn.querySelector(".zs-chip").remove();
    painter.ensureOwnedChip(turn);
    assert.equal(chips(turn).length, 1);
    assert.match(turn.querySelector(".zs-chip-tx").textContent, /read_file/);
    assert.ok(events.some(([event, data]) => event === "chip.rebuild" && data.chipGone));
  });

  test("an intact chip is left alone: no rebuild, no log", () => {
    const { painter, turn, events } = setup();
    painter.toolBox(turn, "read_file", "done", "", true);
    const before = turn.querySelector(".zs-chip");
    painter.ensureOwnedChip(turn);
    assert.equal(turn.querySelector(".zs-chip"), before);
    assert.ok(!events.some(([event]) => event === "chip.rebuild"));
  });

  test("a turn the loop never painted has nothing to rebuild", () => {
    const { painter, turn } = setup();
    painter.ensureOwnedChip(turn);
    assert.equal(chips(turn).length, 0);
  });

  test("a whole-turn chip (a result we injected) hides the turn and carries the chip as its first child", () => {
    const { painter, document } = setup();
    const user = document.getElementById("user");
    painter.chip(user, { label: "read_file · result", category: "read", body: "text", phase: "result", cls: "result", whole: true });
    assert.ok(user.classList.contains("zs-hidden"));
    assert.equal(user.firstElementChild.className.includes("zs-chip"), true);
  });

  test("a missing turn is ignored", () => {
    const { painter } = setup();
    assert.doesNotThrow(() => painter.toolBox(null, "x", "run", "", false));
  });

  test("a site that re-renders the turn's content: the chip pinned at the turn root survives it", () => {
    const { painter, turn } = setup({ atItemLevel: true });
    painter.toolBox(turn, "read_file", "run", "", false);
    assert.equal(turn.firstElementChild.className.includes("zs-chip"), true);
    turn.querySelector(".reply").replaceWith(turn.ownerDocument.createElement("div"));
    painter.toolBox(turn, "read_file", "done", "", false);
    assert.equal(chips(turn).length, 1, "still one chip after the content subtree was replaced");
  });
});
