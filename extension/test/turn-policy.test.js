import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRUNCATED_RESUMES, parseErrorDetail, planTurn } from "../src/domain/agent/turn-policy.js";
import { FEEDBACK } from "../src/domain/prompt/feedback.js";

const ctx = (over = {}) => ({ displayName: "TestAI", truncCount: 0, isHalted: () => false, ...over });

describe("planTurn: ending the loop", () => {
  const cases = [
    [{ kind: "context_limit", detail: "full." }, "limit", "TestAI reached its context limit", "full. New chat."],
    [{ kind: "too_long" }, "limit", "Conversation too long", "Too long. Start a new chat."],
    [{ kind: "timeout" }, "warn", "No response from TestAI", "Timed out. Agent stopped."],
    [{ kind: "empty" }, "warn", "TestAI returned an empty reply", "Nothing received. Try again."],
  ];
  for (const [res, level, title, text] of cases) {
    test(`${res.kind} ends with a banner`, () => {
      const plan = planTurn(res, ctx());
      assert.equal(plan.type, "end");
      assert.deepEqual(plan.banner, { level, title, text });
    });
  }

  test("an empty reply is also traced", () => assert.equal(planTurn({ kind: "empty" }, ctx()).diag, "empty.end"));

  test("a plain-text answer ends quietly and resets the truncation count", () => {
    const plan = planTurn({ kind: "text", text: "hi" }, ctx({ truncCount: 3 }));
    assert.deepEqual([plan.type, plan.banner, plan.truncCount], ["end", undefined, 0]);
  });
});

describe("planTurn: truncated replies", () => {
  test("resumes and counts consecutive resumes", () => {
    const plan = planTurn({ kind: "truncated", item: {} }, ctx({ truncCount: 2 }));
    assert.deepEqual([plan.type, plan.truncCount], ["resume-truncated", 3]);
  });

  test("a halted turn is never resumed", () => {
    const plan = planTurn({ kind: "truncated", item: {} }, ctx({ isHalted: () => true }));
    assert.deepEqual([plan.type, plan.diag], ["end", "truncated.halted"]);
  });

  test("after the limit: keep the partial text as the answer, or warn when there is none", () => {
    const over = ctx({ truncCount: MAX_TRUNCATED_RESUMES });
    assert.deepEqual(planTurn({ kind: "truncated", text: "partial" }, over).banner, undefined);
    assert.equal(planTurn({ kind: "truncated" }, over).banner.title, "Reply kept getting cut off");
  });

  test("isHalted is only consulted for truncated replies", () => {
    let asked = 0;
    planTurn({ kind: "text" }, ctx({ isHalted: () => ++asked }));
    assert.equal(asked, 0);
  });
});

describe("planTurn: commands", () => {
  test("one call runs, with its category", () => {
    const plan = planTurn({ kind: "tool", calls: [{ tool: "read_file" }] }, ctx());
    assert.deepEqual([plan.type, plan.call.tool, plan.category], ["run", "read_file", "read"]);
  });

  test("a tool known to return images gets the screen category", () => {
    const plan = planTurn({ kind: "tool", calls: [{ tool: "vscode/snap" }] }, ctx({ isLearnedImageTool: (n) => n === "vscode/snap" }));
    assert.equal(plan.category, "screen");
  });

  test("several calls in one reply are rejected with the offending names", () => {
    const plan = planTurn({ kind: "tool", calls: [{ tool: "a" }, {}] }, ctx({ truncCount: 4 }));
    assert.deepEqual([plan.type, plan.feedback, plan.truncCount], ["feedback", FEEDBACK.multiTool(["a", "?"]), 0]);
  });

  test("parse errors name the command, label the chip and ask for a rewrite", () => {
    const item = { id: 1 };
    const plan = planTurn({ kind: "parse_error", reason: "unclosed", raw: '{"command":"edit_file","params":{', item }, ctx());
    assert.equal(plan.type, "parse-error");
    assert.deepEqual(plan.chip, { item, name: "edit_file", detail: "cut off", category: "edit" });
    assert.equal(plan.feedback, FEEDBACK.parseError("unclosed"));
  });

  test("a parse error with no node has no chip; unknown name falls back to 'command'", () => {
    const plan = planTurn({ kind: "parse_error", reason: "x", raw: "garbage" }, ctx());
    assert.equal(plan.chip, null);
  });

  test("unknown kinds are skipped", () => assert.equal(planTurn({ kind: "weird" }, ctx()).type, "skip"));

  test("parse-error labels", () => {
    assert.deepEqual(["unclosed", "envelope", "dsml", "other"].map(parseErrorDetail), ["cut off", "bad format", "wrong format", "bad JSON"]);
  });
});
