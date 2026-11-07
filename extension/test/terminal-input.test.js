import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createTerminal } from "../src/page/terminal.js";

function setup() {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const copied = [];
  const t = createTerminal({ document: window.document, diag: () => {}, copy: async (text) => { copied.push(text); return true; } });
  t.start();
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const submit = (text) => { $(".zs-t-input").value = text; $(".zs-t-run").click(); };
  return { t, copied, $, $$, submit };
}
const begin = (t, key, label = "npm test") => t.begin({ key, name: "run_command", label });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const visibleOutput = (page) => page.$$(".zs-t-term").filter((el) => !el.hidden).map((el) => el.textContent);

describe("the output shown is the selected job's own", () => {
  test("selecting a tab swaps the output to that job's", () => {
    const page = setup();
    begin(page.t, "k1");
    page.t.ingest({ jobKey: "k1", text: "one\n" });
    begin(page.t, "k2");
    page.t.ingest({ jobKey: "k2", text: "two\n" });
    assert.equal(visibleOutput(page).length, 1);
    assert.match(visibleOutput(page)[0], /two/);
    page.$$(".zs-t-tab").find((el) => el.dataset.key === "k1").click();
    assert.equal(visibleOutput(page).length, 1);
    assert.match(visibleOutput(page)[0], /one/);
    assert.doesNotMatch(visibleOutput(page)[0], /two/);
  });

  test("the stylesheet lets the hidden attribute win over the output's display rule", () => {
    const css = readFileSync(new URL("../static/overlay.css", import.meta.url), "utf8");
    assert.match(css, /\.zs-t-term\[hidden\]\s*\{\s*display:\s*none/);
  });

  test("a tab name with markup is shown as text", () => {
    const page = setup();
    begin(page.t, "k1", "echo <b>hi</b>");
    assert.equal(page.$(".zs-t-name b"), null);
    assert.match(page.$(".zs-t-name").textContent, /<b>hi<\/b>/);
  });

  test("a command that streamed nothing shows the result the AI was given", () => {
    const page = setup();
    begin(page.t, "k1");
    page.t.finish("k1", "success", "first\nsecond");
    assert.equal(page.$$(".zs-t-line").length, 2);
  });

  test("settling twice keeps the first status", () => {
    const page = setup();
    begin(page.t, "k1");
    page.t.finish("k1", "failed");
    page.t.finish("k1", "success");
    assert.match(page.$(".zs-t-tab").className, /zs-t-failed/);
  });
});

describe("copying one job's output", () => {
  test("copies what streamed so far, then the result once the job has one", async () => {
    const page = setup();
    begin(page.t, "k1");
    page.t.ingest({ jobKey: "k1", text: "a\nb\n" });
    page.$(".zs-t-copy").click();
    await tick();
    assert.deepEqual(page.copied, ["a\nb"]);
    page.t.finish("k1", "success", "RESULT");
    page.$(".zs-t-copy").click();
    await tick();
    assert.equal(page.copied[1], "RESULT");
  });

  test("copies only the selected job", async () => {
    const page = setup();
    begin(page.t, "k1");
    page.t.ingest({ jobKey: "k1", text: "first job\n" });
    begin(page.t, "k2");
    page.t.ingest({ jobKey: "k2", text: "second job\n" });
    page.$$(".zs-t-tab").find((el) => el.dataset.key === "k1").click();
    page.$(".zs-t-copy").click();
    await tick();
    assert.deepEqual(page.copied, ["first job"]);
  });
});

describe("commands typed into the terminal", () => {
  test("a typed command runs under its own tab and shows its result", async () => {
    const page = setup();
    const seen = [];
    page.t.setRunner(async (call, options) => { seen.push({ call, options }); return "OK done"; });
    page.submit('{"command":"git_status","params":{}}');
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].call.tool, "git_status");
    assert.equal(typeof seen[0].options.jobKey, "string");
    assert.match(page.$(".zs-t-tab").className, /zs-t-success/);
    assert.match(visibleOutput(page)[0], /OK done/);
    assert.equal(page.$(".zs-t-input").value, "", "the input is cleared once it was accepted");
  });

  test("several typed commands run in order", async () => {
    const page = setup();
    const order = [];
    page.t.setRunner(async (call) => { order.push(call.tool); return "fine"; });
    page.submit('{"command":"git_add","params":{"paths":["a"]}}\n{"command":"git_commit","params":{"message":"x"}}');
    await tick();
    assert.deepEqual(order, ["git_add", "git_commit"]);
    assert.equal(page.$$(".zs-t-tab").length, 2);
  });

  test("nothing after a failed command runs", async () => {
    const page = setup();
    const order = [];
    page.t.setRunner(async (call, { jobKey }) => {
      order.push(call.tool);
      page.t.finish(jobKey, "failed", "ERROR: boom");
      return "ERROR: boom";
    });
    page.submit('{"command":"git_add","params":{}} {"command":"git_commit","params":{"message":"x"}}');
    await tick();
    assert.deepEqual(order, ["git_add"]);
  });

  test("text without a command is refused and kept for fixing", async () => {
    const page = setup();
    let ran = 0;
    page.t.setRunner(async () => { ran += 1; return "x"; });
    page.submit("hello there");
    await tick();
    assert.equal(ran, 0);
    assert.match(page.$(".zs-t-hint").textContent, /No command found/);
    assert.equal(page.$(".zs-t-input").value, "hello there");
  });

  test("Ctrl+Enter in the input runs it", async () => {
    const page = setup();
    const seen = [];
    page.t.setRunner(async (call) => { seen.push(call.tool); return "ok"; });
    const input = page.$(".zs-t-input");
    input.value = '{"command":"git_log","params":{}}';
    input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await tick();
    assert.deepEqual(seen, ["git_log"]);
  });
});
