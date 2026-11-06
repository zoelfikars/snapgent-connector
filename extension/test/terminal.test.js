import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { feed, lineHtml, state } from "../src/ui/ansi.js";
import { createTerminal } from "../src/page/terminal.js";

describe("ansi.feed", () => {
  const drained = (initial, ...chunks) => {
    let parsed = null;
    const lines = [];
    for (const chunk of chunks) {
      parsed = feed(parsed ? parsed.state : initial, chunk);
      lines.push(...parsed.lines);
    }
    return { lines, state: parsed.state };
  };

  test("splits lines and clears by carriage return, as a progress bar does", () => {
    const { lines } = drained(state(), "first\n", "33%\r50%\r60%\n");
    assert.equal(lines[0].map((s) => s.text).join(""), "first");
    assert.equal(lines[1].map((s) => s.text).join(""), "60%");
  });

  test("an escape cut by the chunk end continues in the next chunk", () => {
    const { lines } = drained(state(), "before \x1b[3", "2mwarning\nplain\n");
    const one = lines[0];
    assert.equal(one.map((s) => s.text).join(""), "before warning");
    assert.ok(one.every((s) => !s.codes.some((code) => code >= 90)), "the bare '3' was not read as a code");
  });

  test("colours are parsed into codes and rendered as classes", () => {
    const { lines } = drained(state(), "\x1b[1;31merror \x1b[32mok\x1b[0m\n");
    const html = lineHtml(lines[0]);
    assert.match(html, /zs-a-fg1/);
    assert.match(html, /zs-a-fg2/);
    assert.match(html, /zs-a-bold/);
    assert.ok(!lineHtml(lines[0]).includes("&lt;"), "plain text stays plain");
  });

  test("HTML in the output is escaped", () => {
    const { lines } = drained(state(), "<script>alert(1)</script>\n");
    const html = lineHtml(lines[0]);
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;script/);
  });
});

describe("the terminal panel store", () => {
  function setup() {
    const { window } = new JSDOM("<!doctype html><body></body>");
    const events = [];
    const diag = (event, data) => events.push({ event, data });
    const t = createTerminal({ document: window.document, diag });
    t.start();
    return { window, t, events, $: (s) => window.document.querySelector(s), $$: (s) => [...window.document.querySelectorAll(s)] };
  }
  const begin = (t, key = "k1", name = "run_command", label = "npm test") => t.begin({ key, name, label });

  test("an unknown jobKey is left alone: other chats run in other pages", () => {
    const { t } = setup();
    t.ingest({ type: "tool_stream", jobKey: "nope", stream: "stdout", text: "hi\n" });
    assert.equal(t.runningCount(), 0);
  });

  test("a begun command is a running tab, and its chunks become lines", () => {
    const page = setup();
    begin(page.t);
    assert.deepEqual(page.t.runningCount(), 1);
    page.t.ingest({ jobKey: "k1", stream: "stdout", text: "installing\nbundling\n" });
    const body = page.$(".zs-t-term");
    assert.equal(body.querySelectorAll(".zs-t-line").length, 2);
    assert.match(page.$(".zs-t-tab").textContent, /npm test/);
    assert.match(page.$(".zs-t-dot").textContent, /●/);
  });

  test("the tab settles with the call's answer and stops counting as running", () => {
    const page = setup();
    begin(page.t);
    page.t.finish("k1", "success");
    assert.deepEqual(page.t.runningCount(), 0);
    const statuses = page.$$(".zs-t-tab").map((el) => el.className);
    assert.match(statuses.join(" "), /zs-t-success/);
  });

  test("Stop on the running tab goes out through the wired cancel callback", () => {
    const page = setup();
    const asked = [];
    page.t.setCancel((key, name) => asked.push([key, name]));
    begin(page.t);
    page.$(".zs-t-stop").click();
    assert.deepEqual(asked, [["k1", "run_command"]]);
  });

  test("the Stop button is hidden once the command settles", () => {
    const page = setup();
    begin(page.t);
    page.t.finish("k1", "failed");
    assert.equal(page.$(".zs-t-stop").hidden, true);
  });

  test("finished tabs cap: the oldest finished ones go first, the running one never", () => {
    const page = setup();
    for (let index = 0; index < 25; index++) {
      begin(page.t, `k${index}`, "run_command", `command ${index}`);
      page.t.finish(`k${index}`, "success");
    }
    begin(page.t, "running", "run_command", "the running one");
    assert.equal(page.t.runningCount(), 1);
    const keys = page.$$(".zs-t-tab").map((el) => el.dataset.key);
    assert.equal(keys.length, 20, "at most 20 tabs");
    assert.ok(keys.includes("running"));
    assert.ok(!keys.includes("k0"), "the oldest finished tab was dropped");
    assert.ok(keys.includes("k24"), "the newest ones stay");
  });

  test("the brightest lines survive the cap: nothing is written after finish", () => {
    const page = setup();
    begin(page.t);
    page.t.finish("k1", "success");
    page.t.ingest({ jobKey: "k1", stream: "stdout", text: "late\n" });
    assert.equal(page.$(".zs-t-line"), null);
  });
});
