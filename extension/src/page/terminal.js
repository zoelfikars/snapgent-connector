// SPDX-License-Identifier: GPL-3.0-or-later
// The terminal panel wired to this page: one tab per command this chat has run (the running one marked
// live), output arriving as `tool_stream` pushes from the background worker, and Stop on the running
// tab asking the server to end the process. Each tab keeps its own output (and the result the AI was
// given), so Copy hands over exactly one job. Commands typed into the panel run apart from the agent
// loop, for when it was interrupted and the user carries on by hand. Tabs live only on this page: a
// reload starts empty, and the output that arrived before is not replayed.

import { createTerminalPanel } from "../ui/terminal-panel.js";
import { openCommandExamples } from "../ui/command-examples.js";
import { exampleCall } from "../domain/tools/example-call.js";
import { feed, state as freshState } from "../ui/ansi.js";
import { parseToolCalls } from "../domain/parser/index.js";
import { jobKey } from "../domain/tools/job-key.js";
import { feedbackIsError, runningDetail } from "../domain/tools/result-summary.js";

const MAX_TABS = 20; // finished commands remembered before the oldest is dropped
const MAX_COPY_LINES = 5000; // streamed lines kept per tab for Copy
const MAX_MANUAL_CALLS = 20; // commands accepted from one submission

/** The clipboard API needs a secure page and a user gesture; the old way covers the sites where it is refused. */
async function copyToClipboard(document, text) {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the textarea trick */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    const done = typeof document.execCommand === "function" && document.execCommand("copy");
    area.remove();
    return !!done;
  } catch { return false; }
}

/**
 * @param {{ document: Document, diag: (event: string, data?: object) => void,
 *           onChange?: () => void, copy?: (text: string) => Promise<boolean> }} deps  `onChange` is a tab being
 *   opened or settled (the bar's badge reads the state); `copy` puts text on the clipboard.
 * @returns {{ toggle: () => void, begin: (job: { key: string, name: string, label: string }) => void,
 *             ingest: (message: object) => void, finish: (key: string, status: string, result?: string) => void,
 *             setCancel: (cancel: (key: string, name: string) => void) => void,
 *             setRunner: (run: (call: object, options: { jobKey: string }) => Promise<string>) => void,
 *             runningCount: () => number, start: () => void }}
 */
export function createTerminal({ document, diag, onChange = () => {}, copy = (text) => copyToClipboard(document, text) }) {
  const panel = createTerminalPanel({ document, onStop: (key) => stop(key), onCopy: (key) => copyTab(key), onRun: (text) => submit(text), onExamples: () => showExamples() });
  const tabs = new Map(); // key -> { key, name, label, status, state, lines, streamed, result }
  let cancel = null;
  let runner = null;
  let toolList = () => [];

  function running() {
    return [...tabs.values()].filter((tab) => tab.status === "running");
  }

  function draw() {
    // Running first (there is at most one per chat), then the finished ones, newest first.
    const ordered = [...running(), ...[...tabs.values()].filter((tab) => tab.status !== "running").reverse()];
    panel.setTabs(ordered.map((tab) => ({ key: tab.key, name: labelOf(tab), status: tab.status })));
    return ordered;
  }

  function labelOf(tab) {
    return tab.label && tab.label.length > 80 ? `${tab.label.slice(0, 77)}…` : tab.label || tab.name;
  }

  function toggle() {
    panel.toggle();
    draw();
  }

  /** A command left the model's reply (or the input) under a job key: it gets a tab, and streams may now arrive for it. */
  function begin({ key, name, label }) {
    if (!key || tabs.has(key)) return;
    tabs.set(key, { key, name, label, status: "running", state: freshState(), lines: [], streamed: false, result: "" });
    // Only the newest finished tabs are kept; the running one is never dropped.
    const finished = [...tabs.values()].filter((tab) => tab.status !== "running");
    while (tabs.size > MAX_TABS && finished.length) {
      const dropped = finished.shift().key;
      tabs.delete(dropped);
      panel.forget(dropped);
    }
    panel.select(key);
    draw();
    onChange();
  }

  /** One `tool_stream` push from the bridge: unknown keys are not ours (other chats run in other pages). */
  function ingest(message) {
    const tab = tabs.get(message && message.jobKey);
    if (!tab || tab.status !== "running" || typeof message.text !== "string" || !message.text) return;
    const parsed = feed(tab.state, message.text);
    for (const segments of parsed.lines) {
      panel.appendLine(tab.key, segments);
      tab.streamed = true;
      tab.lines.push(segments.map((segment) => segment.text).join(""));
      if (tab.lines.length > MAX_COPY_LINES) tab.lines.shift();
      if (!panel.isOpen()) diag("term.unheard", { key: tab.key }); // visible only later, never lost
    }
    tab.state = parsed.state;
  }

  /**
   * The call's answer arrived: the tab settles ("success" | "failed" | "stopped") and keeps `result`, the text the AI
   * was given. A command that streamed nothing shows that text as its output. Settling twice keeps the first status:
   * the runner reports the real one, and a command typed by hand reports again once the runner has returned.
   */
  function finish(key, status, result = "") {
    const tab = tabs.get(key);
    if (!tab) return;
    if (tab.status === "running") tab.status = status;
    if (typeof result === "string" && result && !tab.result) {
      tab.result = result;
      if (!tab.streamed) for (const segments of feed(freshState(), `${result}\n`).lines) panel.appendLine(key, segments);
    }
    draw();
    onChange();
  }

  function setCancel(handler) { cancel = handler; }
  function setRunner(run) { runner = run; }
  /** `list` gives the commands the selected server offers right now. */
  function setTools(list) { toolList = list; }

  function showExamples() {
    openCommandExamples({ document, examples: toolList().map(exampleCall), copy, onUse: (text) => panel.setInput(text) });
  }

  function stop(key) {
    const tab = tabs.get(key);
    if (!tab || tab.status !== "running") return;
    if (!cancel) { diag("term.noCancel"); return; }
    cancel(key, tab.name);
    diag("term.stop", { key });
  }

  /** One job's output for the clipboard: what the AI was (or would be) given, else what streamed so far. */
  async function copyTab(key) {
    const tab = tabs.get(key);
    if (!tab) return;
    const text = tab.result || tab.lines.join("\n");
    let ok = false;
    try { ok = !!(await copy(text)); } catch { ok = false; }
    panel.flashCopy(ok);
    diag("term.copy", { key, chars: text.length, ok });
  }

  /** Text typed into the panel: the commands in it run one after the other, each under its own tab. */
  function submit(text) {
    if (!runner) return { ok: false, error: "Commands cannot be run from here yet." };
    const calls = parseToolCalls(text);
    if (!calls.length) return { ok: false, error: 'No command found. Write it like {"command":"git_status","params":{}}' };
    if (calls.length > MAX_MANUAL_CALLS) return { ok: false, error: `At most ${MAX_MANUAL_CALLS} commands at once.` };
    runManual(calls).catch((error) => diag("term.manualFailed", { error: String((error && error.message) || error) }));
    return { ok: true };
  }

  /** Nothing after a failed or stopped command runs, as in the agent's own batches. */
  async function runManual(calls) {
    const batchId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const key = jobKey(batchId, index, call);
      // The runner opens the tab itself only for commands the server streams; this one covers the rest.
      begin({ key, name: call.tool, label: runningDetail({ arguments: call.arguments }) });
      let feedback;
      try { feedback = await runner(call, { jobKey: key }); } catch (error) { feedback = `ERROR: ${(error && error.message) || error}`; }
      finish(key, feedbackIsError(feedback) ? "failed" : "success", feedback);
      const tab = tabs.get(key);
      if (!tab || tab.status !== "success") break;
    }
  }

  function runningCount() { return running().length; }

  /** Listens for the worker's pushes for as long as the page lives. */
  function start() {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === "tool_stream") ingest(message);
      });
    } catch { /* no extension messaging here */ }
    draw();
  }

  return { toggle, begin, ingest, finish, setCancel, setRunner, setTools, stop, runningCount, start };
}
