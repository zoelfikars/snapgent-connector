import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { showRawViews } from "../src/infrastructure/calibration/raw-view.js";
import { closestName } from "../src/domain/tools/closest-name.js";
import { FEEDBACK } from "../src/domain/prompt/feedback.js";
import { pageWith } from "./support/jsdom-provider.js";

const TREE = `<div class="block"><div class="bar"><button class="t t--active">Tree</button><button class="t ">Raw</button></div><div class="view">tree: paths 5 items</div></div>`;

describe("JSON tree view", () => {
  test("the Raw button beside a Tree button is pressed, once", () => {
    const { document } = pageWith(`<html><body>${TREE}</body></html>`);
    const [tree, raw] = document.querySelectorAll("button");
    raw.addEventListener("click", () => {
      tree.className = "t ";
      raw.className = "t t--active";
      document.querySelector(".view").textContent = '{"command":"read_files"}';
    });
    assert.equal(showRawViews(document.body), 1);
    assert.equal(document.querySelector(".view").textContent, '{"command":"read_files"}');
    assert.equal(showRawViews(document.body), 0, "already on Raw");
  });

  test("a Raw button with no Tree beside it is left alone", () => {
    const { document } = pageWith(`<html><body><div><button>Raw</button></div></body></html>`);
    assert.equal(showRawViews(document.body), 0);
  });
});

describe("unknown command hint", () => {
  const valid = ["read_files", "write_file", "tree"];
  test("a near miss is named", () => {
    assert.equal(closestName(valid, "read_file"), "read_files");
    assert.match(FEEDBACK.unknownTool("read_file", valid), /Did you mean "read_files"\?/);
  });
  test("nothing close gives no hint", () => {
    assert.equal(closestName(valid, "rm_rf"), null);
    assert.doesNotMatch(FEEDBACK.unknownTool("rm_rf", valid), /Did you mean/);
  });
});
