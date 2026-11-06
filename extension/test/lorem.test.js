import { test } from "node:test";
import assert from "node:assert/strict";
import { loremIpsum } from "../src/domain/prompt/lorem.js";

test("the text has exactly the length asked for", () => {
  for (const size of [1, 5, 37, 1000, 20000, 400000]) assert.equal(loremIpsum(size).length, size);
});

test("the same length gives the same text, and a longer text starts with a shorter one", () => {
  assert.equal(loremIpsum(500), loremIpsum(500));
  assert.ok(loremIpsum(500).startsWith(loremIpsum(100)));
});

test("it is plain words: no @ that a page could read as a file tag", () => {
  assert.ok(!loremIpsum(5000).includes("@"));
  assert.ok(loremIpsum(50).startsWith("lorem ipsum dolor"));
});

test("anything that is not a positive number gives no text", () => {
  for (const bad of [0, -5, NaN, undefined, "abc"]) assert.equal(loremIpsum(bad), "");
});
