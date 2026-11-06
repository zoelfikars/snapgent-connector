import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SITES, SITE_LINKS } from "../src/sites/registry.js";

describe("the switch AI shortcuts", () => {
  test("every supported site is offered, DeepSeek included", () => {
    assert.equal(SITE_LINKS.length, SITES.length);
    const deepseek = SITE_LINKS.find((link) => link.name === "DeepSeek");
    assert.ok(deepseek, "DeepSeek is in the menu");
    assert.equal(deepseek.url, "https://chat.deepseek.com/");
  });
});
