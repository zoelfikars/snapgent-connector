import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RESEND_MARKER, SYS_MARKER } from "../src/domain/constants.js";
import { toFeedback, IMAGE_FEEDBACK_RE } from "../src/domain/tools/result-feedback.js";
import { describeResultTurn, describeSystemTurn } from "../src/ui/turn-chips.js";

describe("system-prompt turns", () => {
  test("the bootstrap is 'Starting Up', animated while starting and a gear afterwards", () => {
    const running = describeSystemTurn(`${SYS_MARKER}\nCONTEXT...`, { starting: true });
    assert.deepEqual([running.kind, running.phase, running.chip.label, running.chip.phase, running.chip.cls, running.chip.whole], ["bootstrap", "run", "Starting Up", "run", "sys", true]);
    assert.equal(describeSystemTurn(`${SYS_MARKER} x`, { starting: false }).phase, "sys");
  });

  test("a re-statement is a 'Reminder', never 'Starting Up', even though it carries the bootstrap marker too", () => {
    const text = `Output of 'read_file':\nbody\n${RESEND_MARKER}\n${SYS_MARKER}\nprompt`;
    const turn = describeSystemTurn(text, { starting: true });
    assert.deepEqual([turn.kind, turn.chip.label, turn.chip.detail, turn.chip.category], ["resend", "Reminder", "with read_file result", "remind"]);
  });

  test("a re-statement that rides on nothing has no detail", () => {
    assert.equal(describeSystemTurn(`${RESEND_MARKER} ${SYS_MARKER}`, { starting: false }).chip.detail, "");
  });

  test("ordinary text is not a system turn", () => {
    assert.equal(describeSystemTurn("hello", { starting: false }), null);
  });
});

describe("tool-result turns", () => {
  test("a successful result names its tool, categorises it and keeps the body", () => {
    const text = "Output of 'read_file':\nhello";
    const turn = describeResultTurn(text);
    assert.deepEqual([turn.toolName, turn.isError, turn.hasImage, turn.signature], ["read_file", false, false, "read_file|result"]);
    assert.deepEqual(turn.chip, { label: "read_file · result", category: "read", body: text, phase: "result", cls: "result", whole: true });
  });

  test("an error turn is red and still names the tool when it can", () => {
    const turn = describeResultTurn("ERROR calling 'edit_file': nope");
    assert.deepEqual([turn.isError, turn.chip.phase, turn.chip.cls, turn.signature, turn.toolName], [true, "err", "err", "note|err", null]);
    assert.equal(turn.chip.label, "result");
    assert.equal(describeResultTurn("Output of 'x':\nERROR: later").isError, false, "only a leading ERROR counts");
  });

  test("an image result gets the 'screen' chip, recognised from the exact phrase the runner writes", () => {
    const feedback = toFeedback({ ok: true, text: "shot", images: [{ data: "AA" }] }, { name: "snap", supportsVision: true }).text;
    assert.match(feedback, IMAGE_FEEDBACK_RE, "the two sides of this contract cannot drift apart");
    const turn = describeResultTurn(feedback);
    assert.deepEqual([turn.hasImage, turn.chip.category, turn.signature], [true, "screen", "snap|img"]);
  });

  test("an error never counts as an image result, even with the phrase in it", () => {
    assert.equal(describeResultTurn("ERROR: the image is attached to THIS message").hasImage, false);
  });

  test("text that is not one of our injected shapes is not a result", () => {
    for (const text of ["hello", "I ran Output of 'x' myself", ""]) assert.equal(describeResultTurn(text), null, text);
  });

  test("a system note we sent is a result-style turn without a tool", () => {
    const turn = describeResultTurn("(System note: the reply was cut off.)");
    assert.deepEqual([turn.toolName, turn.chip.label], [null, "result"]);
  });
});
