import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/application/agent-loop.js";
import { BatchProgress } from "../src/application/batch-progress.js";
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

describe("AgentLoop: a reply that was stopped can be run again", () => {
  const twoCommands = { kind: "tool", item: { id: "two" }, calls: [{ tool: "a" }, { tool: "b" }] };

  test("Stop before any command gave a result: the turn is forgotten, so Play may run it again", async () => {
    const h = await run({
      responses: [toolTurn("git_status"), textTurn],
      runner: { run: async (_c, state) => { state.stopped = true; return "(stopped by user)"; } },
    });
    assert.deepEqual(h.events("memory:executed", "memory:forget"), [["memory:executed", "turn"], ["memory:forget", "turn"]]);
  });

  test("Stop after a command already finished: the turn stays remembered, so it is never run twice", async () => {
    const h = await run({
      responses: [twoCommands, textTurn],
      runner: { run: async (call, state) => { if (call.tool === "b") state.stopped = true; return `» ${call.tool}\nok`; } },
    });
    assert.deepEqual(h.events("run"), [["run", "a"], ["run", "b"]]);
    assert.equal(h.events("memory:forget").length, 0);
  });

  test("a batch that completes is not forgotten", async () => {
    const h = await run({ responses: [twoCommands, textTurn] });
    assert.equal(h.events("memory:forget").length, 0);
    assert.equal(h.state.submitted.length, 1);
  });
});

describe("AgentLoop: carrying on after Stop", () => {
  const three = () => ({ kind: "tool", item: { id: "three" }, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] });
  const progressOf = () => new BatchProgress({ conversationKey: () => "chat", keyOf: (item) => item.id });
  const stopAtB = { run: async (call, state) => { if (call.tool === "b") { state.stopped = true; return "(stopped by user)"; } return `» ${call.tool}\nok`; } };

  async function stoppedAtB(progress, reply) {
    const h = createLoopHarness({ responses: [reply], runner: stopAtB });
    h.deps.progress = progress;
    await new AgentLoop(h.deps).run("base-0");
    return h;
  }

  async function runAgain(progress, reply) {
    const h = createLoopHarness({ responses: [reply, textTurn] });
    h.deps.progress = progress;
    await new AgentLoop(h.deps).run("base-1");
    return h;
  }

  test("what finished before Stop is not run again, and its answer goes out with the rest", async () => {
    const progress = progressOf();
    const reply = three();
    const first = await stoppedAtB(progress, reply);
    assert.deepEqual(first.events("run"), [["run", "a"], ["run", "b"]]);
    assert.equal(first.state.submitted.length, 0);
    assert.equal(progress.count(reply.item), 1);

    const h = await runAgain(progress, reply);
    assert.deepEqual(h.events("run"), [["run", "b"], ["run", "c"]]);
    const text = h.state.submitted[0].text;
    assert.ok(text.startsWith("» a\nok\n\n» b\nok"));
    assert.match(text, /interrupted by Stop earlier/);
    assert.ok(text.endsWith("» c\nok"));
    assert.equal(progress.count(reply.item), 0, "answered: the next run of this reply starts over");
  });

  test("a reply that changed since the Stop starts over", async () => {
    const progress = progressOf();
    const reply = three();
    await stoppedAtB(progress, reply);
    const h = await runAgain(progress, { kind: "tool", item: reply.item, calls: [{ tool: "z" }, { tool: "b" }, { tool: "c" }] });
    assert.deepEqual(h.events("run"), [["run", "z"], ["run", "b"], ["run", "c"]]);
    assert.doesNotMatch(h.state.submitted[0].text, /interrupted by Stop/);
  });

  test("Stop on the very first command: nothing is reused, and the command is run again with a note", async () => {
    const progress = progressOf();
    const reply = three();
    const first = createLoopHarness({ responses: [reply], runner: { run: async (_c, state) => { state.stopped = true; return "(stopped by user)"; } } });
    first.deps.progress = progress;
    await new AgentLoop(first.deps).run("base-0");
    assert.equal(progress.count(reply.item), 0);
    const h = await runAgain(progress, reply);
    assert.deepEqual(h.events("run").map((e) => e[1]), ["a", "b", "c"]);
    assert.match(h.state.submitted[0].text, /interrupted by Stop earlier/);
  });
});

describe("BatchProgress", () => {
  const ports = { conversationKey: () => "chat", keyOf: (item) => item.id };

  test("hands back the finished commands that are still the same, in order", () => {
    const progress = new BatchProgress(ports);
    const item = { id: 1 };
    progress.record(item, 0, { tool: "a", arguments: { x: 1 } }, "A", false);
    progress.record(item, 1, { tool: "b" }, "B", true);
    const same = [{ tool: "a", arguments: { x: 1 } }, { tool: "b" }, { tool: "c" }];
    assert.deepEqual(progress.resume(item, same).map((step) => [step.feedback, step.isErr]), [["A", false], ["B", true]]);
  });

  test("a command that differs ends the reusable part and the rest is dropped", () => {
    const progress = new BatchProgress(ports);
    const item = { id: 1 };
    progress.record(item, 0, { tool: "a" }, "A", false);
    progress.record(item, 1, { tool: "b" }, "B", false);
    assert.deepEqual(progress.resume(item, [{ tool: "a" }, { tool: "other" }]).map((step) => step.feedback), ["A"]);
    assert.equal(progress.count(item), 1);
    assert.equal(progress.resume(item, [{ tool: "a", arguments: { changed: true } }]).length, 0, "different arguments are a different command");
  });

  test("another reply or another conversation has its own record, and clear forgets it", () => {
    let conversation = "chat";
    const progress = new BatchProgress({ conversationKey: () => conversation, keyOf: (item) => item.id });
    progress.record({ id: 1 }, 0, { tool: "a" }, "A", false);
    assert.equal(progress.count({ id: 2 }), 0);
    conversation = "other";
    assert.equal(progress.count({ id: 1 }), 0);
    conversation = "chat";
    assert.equal(progress.count({ id: 1 }), 1);
    progress.clear({ id: 1 });
    assert.equal(progress.count({ id: 1 }), 0);
  });

  test("a port that throws (page navigating) never escapes", () => {
    const progress = new BatchProgress({ conversationKey: () => { throw new Error("navigating"); }, keyOf: () => "k" });
    progress.record({}, 0, { tool: "a" }, "A", false);
    assert.deepEqual([progress.count({}), progress.resume({}, [{ tool: "a" }]), progress.wasInterrupted({}, 0)], [0, [], false]);
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
