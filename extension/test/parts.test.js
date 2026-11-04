import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/application/agent-loop.js";
import { PartQueue } from "../src/application/part-queue.js";
import { clampBatchCalls, DEFAULT_BATCH_CALLS, MAX_BATCH_CALLS } from "../src/domain/prompt/budget.js";
import { partMessages, splitIntoParts } from "../src/domain/prompt/parts.js";
import { foldersOf, isTextFile, matchPaths } from "../src/domain/prompt/file-tags.js";
import { createLoopHarness, textTurn, toolTurn } from "./support/loop-fakes.js";

describe("parts: splitting what does not fit", () => {
  test("a text that fits is one message, untouched", () => {
    assert.deepEqual(partMessages("short", 1000), ["short"]);
  });

  test("a longer text becomes parts that each fit, say how many there are and that the last is the last", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const messages = partMessages(text, 1200);
    assert.ok(messages.length > 1);
    for (const message of messages) assert.ok(message.length <= 1200, String(message.length));
    assert.match(messages[0], new RegExp(`Part 1 of ${messages.length}`));
    assert.match(messages[0], /Reply with a few words only/);
    assert.match(messages[1], /^» continued\n\[Part 2 of /);
    assert.match(messages[messages.length - 1], /the last: that is everything/);
  });

  test("nothing is lost between the parts", () => {
    const text = Array.from({ length: 300 }, (_, i) => `row ${i} ${"x".repeat(i % 17)}`).join("\n");
    assert.equal(splitIntoParts(text, 500).join(""), text);
  });

  test("past the most parts the rest is cut out, and says so", () => {
    const pieces = splitIntoParts("a".repeat(1000), 100, 3);
    assert.equal(pieces.length, 3);
    assert.match(pieces[2], /more characters left out/);
  });
});

describe("the commands-per-reply setting", () => {
  test("is kept within the slider and falls back to the default", () => {
    assert.equal(clampBatchCalls(undefined), DEFAULT_BATCH_CALLS);
    assert.equal(clampBatchCalls(0), DEFAULT_BATCH_CALLS);
    assert.equal(clampBatchCalls(500), MAX_BATCH_CALLS);
    assert.equal(clampBatchCalls("12"), 12);
  });
});

describe("AgentLoop: a message that came in parts", () => {
  const withParts = (messages, options = {}) => {
    const h = createLoopHarness(options);
    const parts = new PartQueue();
    parts.hold(messages);
    h.deps.parts = parts;
    return { h, parts };
  };

  test("the model's short answer to a part is not the end: the next part is sent, and the last one gets the real answer", async () => {
    const { h } = withParts(["part 1", "part 2", "part 3"], { responses: [textTurn, textTurn, { kind: "text", text: "the real answer" }] });
    await new AgentLoop(h.deps).run("base-0");
    assert.deepEqual(h.state.submitted.map((m) => m.text), ["part 2", "part 3"]);
    assert.equal(h.events("lifecycle:end").length, 1);
  });

  test("commands sent while parts are still due are not run, and the model is told", async () => {
    const { h } = withParts(["one", "two"], { responses: [toolTurn("run_command"), textTurn] });
    await new AgentLoop(h.deps).run("base-0");
    assert.equal(h.events("run").length, 0);
    assert.match(h.state.submitted[0].text, /^\[The commands in your last reply were not run/);
    assert.match(h.state.submitted[0].text, /two$/);
  });

  test("a stopped loop forgets the parts that were not sent", async () => {
    const { h, parts } = withParts(["one", "two", "three"], { responses: [(state) => { state.stopped = true; return textTurn; }] });
    await new AgentLoop(h.deps).run("base-0");
    assert.equal(parts.pending(), false);
  });
});

describe("folders", () => {
  test("every level of a file's path is a folder, written with its closing slash", () => {
    assert.deepEqual(foldersOf(["a/b/c.go", "a/d.go", "e.go"]).sort(), ["a/", "a/b/"]);
  });

  test("images, archives and lock files are not read as text", () => {
    assert.equal(isTextFile("main.go"), true);
    assert.equal(isTextFile("logo.PNG"), false);
    assert.equal(isTextFile("go.sum"), false);
  });

  test("a folder is found by its own name before the files inside it", () => {
    assert.equal(matchPaths(["cmd/api/main.go", "api/"], "api")[0], "api/");
  });
});

describe("BatchRunner: output that does not fit in one message", () => {
  const two = { kind: "tool", item: {}, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] };
  const big = (call) => `» ${call.tool}\n${`${call.tool} output\n`.repeat(400)}`;

  test("goes out in parts, the first one now and the rest when the model has answered", async () => {
    const h = createLoopHarness({ responses: [two, textTurn, textTurn, textTurn, textTurn, textTurn], runner: { run: async (call) => big(call) } });
    h.deps.budget = { limit: () => 6000, calls: () => 3 };
    h.deps.parts = new PartQueue();
    await new AgentLoop(h.deps).run("base-0");
    const sent = h.state.submitted.map((m) => m.text);
    assert.ok(sent.length >= 2, `${sent.length} messages`);
    assert.match(sent[0], /^» a\n/);
    assert.match(sent[0], /Part 1 of /);
    assert.match(sent[sent.length - 1], /the last: that is everything/);
    for (const text of sent) assert.ok(text.length <= 6000, String(text.length));
  });

  test("with a smaller commands-per-reply setting the others are reported as not run", async () => {
    const h = createLoopHarness({ responses: [two, textTurn] });
    h.deps.budget = { limit: () => 100000, calls: () => 1 };
    await new AgentLoop(h.deps).run("base-0");
    assert.equal(h.events("run").length, 1);
    assert.match(h.state.submitted[0].text, /NOT RUN \(at most 1 commands per reply\): b, c/);
  });
});
