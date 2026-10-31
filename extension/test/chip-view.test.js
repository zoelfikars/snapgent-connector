import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { paintChip, chipSignature } from "../src/ui/chip-view.js";
import { iconFor, ICONS, SPIN } from "../src/ui/chip-icons.js";

const doc = () => new JSDOM("<!doctype html><body></body>").window.document;

describe("iconFor", () => {
  test("the phase wins over the category", () => {
    assert.equal(iconFor("read", "run"), SPIN);
    assert.equal(iconFor("read", "err"), ICONS.error);
    assert.equal(iconFor("read", "done"), ICONS.check);
    assert.equal(iconFor("read", "result"), ICONS.result);
    assert.equal(iconFor("tool", "sys"), ICONS.gear);
    assert.equal(iconFor("tool", "remind"), ICONS.remind);
  });

  test("an idle chip uses its category icon; an unknown category falls back to the wrench", () => {
    assert.equal(iconFor("screen", "idle"), ICONS.screen);
    assert.equal(iconFor("nonsense", "idle"), ICONS.tool);
  });
});

describe("paintChip", () => {
  test("draws label, detail and category classes", () => {
    const d = doc();
    const chip = paintChip(d, null, { label: "read_file", detail: "a.js", category: "read", phase: "done", cls: "done" });
    assert.ok(chip.classList.contains("zs-chip"));
    assert.ok(chip.classList.contains("cat-read"));
    assert.ok(chip.classList.contains("done"));
    assert.equal(chip.querySelector(".zs-chip-tx").textContent, "read_file");
    assert.equal(chip.querySelector(".zs-chip-dt").textContent, "a.js");
    assert.equal(chip.querySelector(".zs-chip-cv"), null, "no body, no chevron");
  });

  test("label, detail and body are text, never markup", () => {
    const d = doc();
    const evil = "<img src=x onerror=alert(1)>";
    const chip = paintChip(d, null, { label: evil, detail: evil, body: evil, phase: "result" });
    assert.equal(chip.querySelector("img"), null);
    assert.equal(chip.querySelector(".zs-chip-tx").textContent, evil);
    assert.equal(chip.querySelector(".zs-chip-dt").textContent, evil);
    assert.equal(chip.querySelector(".zs-chip-body pre").textContent, evil);
  });

  test("a body adds a chevron and the header toggles it open and closed", () => {
    const d = doc();
    const chip = paintChip(d, null, { label: "x", body: "output", phase: "result" });
    assert.ok(chip.querySelector(".zs-chip-cv"));
    const head = chip.querySelector(".zs-chip-head");
    head.click();
    assert.ok(chip.classList.contains("open"));
    head.click();
    assert.ok(!chip.classList.contains("open"));
  });

  test("an identical call keeps the same spinner element, so its animation never restarts", () => {
    const d = doc();
    const opts = { label: "run_tests", category: "tool", phase: "run", cls: "run" };
    const chip = paintChip(d, null, opts);
    const spinner = chip.querySelector(".zs-spin");
    assert.ok(spinner);
    const again = paintChip(d, chip, { ...opts });
    assert.equal(again, chip);
    assert.equal(again.querySelector(".zs-spin"), spinner);
  });

  test("a changed phase rebuilds the chip and swaps the icon", () => {
    const d = doc();
    const chip = paintChip(d, null, { label: "run_tests", phase: "run", cls: "run" });
    assert.ok(chip.querySelector(".zs-spin"));
    paintChip(d, chip, { label: "run_tests", phase: "done", cls: "done" });
    assert.equal(chip.querySelector(".zs-spin"), null);
    assert.ok(chip.classList.contains("done"));
    assert.ok(!chip.classList.contains("run"));
  });

  test("an expanded chip stays expanded while its content is unchanged", () => {
    const d = doc();
    const opts = { label: "x", body: "output", phase: "result", cls: "result" };
    const chip = paintChip(d, null, opts);
    chip.classList.add("open");
    paintChip(d, chip, { ...opts });
    assert.ok(chip.classList.contains("open"));
  });
});

describe("chipSignature", () => {
  test("differs when anything visible differs, and defaults match the renderer", () => {
    const base = { label: "a", phase: "run" };
    assert.equal(chipSignature(base), chipSignature({ ...base, detail: "", body: "", category: "tool" }));
    for (const change of [{ label: "b" }, { phase: "done" }, { detail: "d" }, { body: "x" }, { category: "read" }, { cls: "err" }, { whole: true }]) {
      assert.notEqual(chipSignature(base), chipSignature({ ...base, ...change }), JSON.stringify(change));
    }
  });
});
