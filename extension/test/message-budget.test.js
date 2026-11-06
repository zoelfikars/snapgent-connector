import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createMessageBudget } from "../src/page/message-budget.js";

const storage = { get: async () => undefined, watch() {}, remove() {}, set() {} };
const budgetFor = (provider) => createMessageBudget({ storage, hostname: "x.test", provider, diag() {} });

describe("message budget: this AI's own values", () => {
  test("a calibration's values win over the general ones, and are read again when the provider changes", () => {
    const provider = { limits: { chars: 50000, calls: 3 }, conversationKey: () => "k" };
    const budget = budgetFor(provider);
    assert.equal(budget.limit(), 50000);
    assert.equal(budget.calls(), 3);
    provider.limits = null;
    assert.equal(budget.limit(), 100000);
    assert.equal(budget.calls(), 8);
  });

  test("a value outside what the sliders allow is brought back into range", () => {
    const budget = budgetFor({ limits: { chars: 5000, calls: 99 }, conversationKey: () => "k" });
    assert.equal(budget.limit(), 20000);
    assert.equal(budget.calls(), 30);
  });

  test("only one of the two can be set; the other stays general", () => {
    const budget = budgetFor({ limits: { calls: 2 }, conversationKey: () => "k" });
    assert.equal(budget.limit(), 100000);
    assert.equal(budget.calls(), 2);
  });

  test("a send limit the site has is still a ceiling above the calibration's value", () => {
    const budget = budgetFor({ limits: { chars: 300000 }, sendCharBudget: 80000, conversationKey: () => "k" });
    assert.equal(budget.limit(), 80000);
  });
});
