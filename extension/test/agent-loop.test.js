import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/application/agent-loop.js";
import { FEEDBACK } from "../src/domain/prompt/feedback.js";
import { flush } from "./support/fakes.js";
import { createLoopHarness, textTurn, toolTurn } from "./support/loop-fakes.js";

const run = async (options) => {
  const h = createLoopHarness(options);
  await new AgentLoop(h.deps).run("base-0");
  return h;
};

describe("AgentLoop: lifecycle", () => {
  test("a plain answer starts and ends the loop and runs nothing", async () => {
    const h = await run({ responses: [textTurn] });
    assert.deepEqual(h.events("lifecycle:start", "lifecycle:end", "run").map((e) => e[0]), ["lifecycle:start", "lifecycle:end"]);
  });

  test("lifecycle.end runs even when something throws, and the error is surfaced", async () => {
    const h = await run({ responses: [toolTurn("read_file")], runner: { run: async () => { throw new Error("kaboom"); } } });
    assert.deepEqual(h.events("banner")[0], ["banner", "warn", "Internal loop error", "kaboom"]);
    assert.equal(h.events("lifecycle:end").length, 1);
  });

  test("the watchdog is stopped when the loop ends", async () => {
    const h = await run({ responses: [textTurn] });
    assert.equal(h.timers.active, 0);
  });
});

describe("AgentLoop: a command round-trip", () => {
  test("announces the command, runs it, and feeds the result back as the next base", async () => {
    const h = await run({ responses: [toolTurn("read_file", { path: "a.js" }), textTurn] });
    assert.deepEqual(h.events("tool:running", "memory:executed", "run", "tool:finished", "submit").map((e) => e[0]),
      ["tool:running", "memory:executed", "run", "tool:finished", "submit"]);
    assert.deepEqual(h.events("tool:running")[0], ["tool:running", "read_file"]);
    assert.equal(h.state.submitted[0].text, "» read_file\nok");
    // the loop waits on the base returned by submit
    assert.deepEqual(h.events("next").map((e) => e[1]), ["base-0", "base-1"]);
  });

  test("a failing tool is reported to the model and the loop carries on", async () => {
    const h = await run({ responses: [toolTurn("edit_file"), textTurn], runner: { run: async () => "ERROR: nope" } });
    assert.equal(h.state.submitted[0].text, "ERROR: nope");
    assert.equal(h.events("next").length, 2);
  });

  test("two commands in one reply both run and are answered with one message", async () => {
    const both = { kind: "tool", item: {}, calls: [{ tool: "a" }, { tool: "b" }] };
    const h = await run({ responses: [both, textTurn] });
    assert.deepEqual(h.events("run"), [["run", "a"], ["run", "b"]]);
    assert.equal(h.state.submitted.length, 1);
    assert.equal(h.state.submitted[0].text, "» a\nok\n\n» b\nok");
  });

  test("the cover says what is happening, command by command, until the results are sent", async () => {
    const both = { kind: "tool", item: {}, calls: [{ tool: "apply_patch" }, { tool: "read_files" }] };
    const h = await run({ responses: [both, textTurn] });
    assert.deepEqual(h.events("progress").map((e) => e[1]), [
      "Running command 1/2 · apply_patch",
      "Running command 2/2 · read_files",
      "2/2 commands done · sending the results to the AI…",
    ]);
  });

  test("calls the model wrote in its own markup run, and the answer tells it to use our commands", async () => {
    const native = { kind: "tool", item: {}, calls: [{ tool: "a", native: "dsml" }, { tool: "b", native: "dsml" }] };
    const h = await run({ responses: [native, textTurn] });
    assert.deepEqual(h.events("run"), [["run", "a"], ["run", "b"]]);
    const text = h.state.submitted[0].text;
    assert.ok(text.startsWith("» a\nok\n\n» b\nok"));
    assert.ok(text.endsWith(FEEDBACK.nativeFormat), "the note is the last thing in the message");
    assert.doesNotMatch(FEEDBACK.nativeFormat, /DSML/i, "the note describes the markup and never quotes it");
  });

  test("a parse error asks the model to rewrite", async () => {
    const h = await run({ responses: [{ kind: "parse_error", reason: "unclosed", raw: '{"command":"edit_file"', item: { id: 1 } }, textTurn] });
    assert.equal(h.state.submitted[0].text, FEEDBACK.parseError("unclosed"));
  });
});

describe("AgentLoop: stopping", () => {
  test("Stop during a tool sends nothing back", async () => {
    const h = await run({
      responses: [toolTurn("git_status"), textTurn],
      runner: { run: async (_c, state) => { state.stopped = true; return "(stopped by user)"; } },
    });
    assert.equal(h.state.submitted.length, 0);
    assert.equal(h.events("next").length, 1);
  });

  test("a 'stopped' response ends the loop", async () => {
    const h = await run({ responses: [{ kind: "stopped" }] });
    assert.equal(h.events("banner").length, 0);
    assert.equal(h.events("lifecycle:end").length, 1);
  });

  test("a stall reported by the watchdog halts the loop and tells the user", async () => {
    const h = createLoopHarness({ responses: [() => new Promise(() => {})] });
    const loop = new AgentLoop(h.deps).run("base-0");
    await flush();
    h.timers.advance(190000);
    assert.deepEqual(h.events("banner")[0], ["banner", "warn", "Agent stopped waiting", "No progress for 3 min. Send continue to resume."]);
    assert.equal(h.events("lifecycle:halt").length, 1);
    h.state.stopped = true;
    void loop; // the pending wait is abandoned by the page in reality
  });
});

describe("AgentLoop: hidden tab", () => {
  test("parks before reading, and again before dispatching a tool", async () => {
    const h = createLoopHarness({ responses: [toolTurn("git_status"), textTurn], hidden: true });
    await new AgentLoop(h.deps).run("base-0");
    assert.ok(h.names().indexOf("waitUntilVisible") < h.names().indexOf("next"));
    assert.equal(h.events("cover").length, 1);
  });

  test("a tab that goes hidden after the reply was read parks before the command is announced", async () => {
    const h = createLoopHarness({ responses: [(state) => { state.hidden = true; return toolTurn("git_status"); }, textTurn] });
    await new AgentLoop(h.deps).run("base-0");
    const names = h.names();
    assert.ok(names.indexOf("waitUntilVisible") < names.indexOf("tool:running"));
    assert.ok(names.includes("diag:tool.parkBeforeDispatch"));
  });
});

describe("AgentLoop: terminal and truncated replies", () => {
  test("a timeout announces itself and ends", async () => {
    const h = await run({ responses: [{ kind: "timeout" }] });
    assert.deepEqual(h.events("banner")[0], ["banner", "warn", "No response from TestAI", "Timed out. Agent stopped."]);
  });

  test("truncated + Continue worked: same base, no message sent", async () => {
    const h = await run({ responses: [{ kind: "truncated", item: {} }, textTurn], resumeTruncated: true });
    assert.equal(h.state.submitted.length, 0);
    assert.deepEqual(h.events("next").map((e) => e[1]), ["base-0", "base-0"]);
  });

  test("truncated + no Continue button: sends the fallback message and waits on its base", async () => {
    const h = await run({ responses: [{ kind: "truncated", item: {} }, textTurn], resumeTruncated: false });
    assert.equal(h.state.submitted[0].text, FEEDBACK.truncated);
    assert.deepEqual(h.events("toast")[0], ["toast", "Resuming…"]);
    assert.deepEqual(h.events("next").map((e) => e[1]), ["base-0", "base-1"]);
  });

  test("a halted truncated turn is not resumed", async () => {
    const h = await run({ responses: [{ kind: "truncated", item: {} }], halted: true });
    assert.equal(h.events("resumeTruncated").length, 0);
  });
});

describe("AgentLoop: reminders", () => {
  test("the command list rides along every Nth successful result", async () => {
    const h = await run({ responses: [toolTurn("a"), toolTurn("b"), toolTurn("c"), textTurn], reminderEvery: 2 });
    assert.deepEqual(h.state.submitted.map((s) => s.text.endsWith("[REMINDER]")), [false, true, false]);
  });

  test("no reminder is attached when the catalogue is empty", async () => {
    const h = await run({ responses: [toolTurn("a"), toolTurn("b"), textTurn], reminderEvery: 1, hasCatalogue: false });
    assert.ok(h.state.submitted.every((s) => !s.text.includes("[REMINDER]")));
  });
});
