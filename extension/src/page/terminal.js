// SPDX-License-Identifier: GPL-3.0-or-later
// The terminal panel wired to this page: one tab per command this chat has run (the running one marked
// live), output arriving as `tool_stream` pushes from the background worker, and Stop on the running
// tab asking the server to end the process. Tabs live only on this page: a reload starts empty, and
// the output that arrived before is not replayed (the finished result still goes to the chat).

import { createTerminalPanel } from "../ui/terminal-panel.js";
import { feed, state as freshState } from "../ui/ansi.js";

const MAX_TABS = 20; // finished commands remembered before the oldest is dropped

/**
 * @param {{ document: Document, diag: (event: string, data?: object) => void,
 *           onChange?: () => void }} deps  `onChange` is a tab being opened or settled (the bar's badge reads the state).
 * @returns {{ toggle: () => void, begin: (job: { key: string, name: string, label: string }) => void,
 *             ingest: (message: object) => void, finish: (key: string, status: string) => void,
 *             setCancel: (cancel: (key: string, name: string) => void) => void,
 *             runningCount: () => number, start: () => void }}
 */
export function createTerminal({ document, diag, onChange = () => {} }) {
  const panel = createTerminalPanel({ document, onStop: (key) => stop(key) });
  const tabs = new Map(); // key -> { key, name, label, status, state, first }
  let cancel = null;

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

  /** A command left the model's reply under a job key: it gets a tab, and streams may now arrive for it. */
  function begin({ key, name, label }) {
    if (!key || tabs.has(key)) return;
    tabs.set(key, { key, name, label, status: "running", state: freshState() });
    // Only the newest finished tabs are kept; the running one is never dropped.
    const finished = [...tabs.values()].filter((tab) => tab.status !== "running");
    while (tabs.size > MAX_TABS && finished.length) tabs.delete(finished[0].key);
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
      if (!panel.isOpen()) diag("term.unheard", { key: tab.key }); // visible only later, never lost
    }
    tab.state = parsed.state;
  }

  /** The call's bridge answer arrived: the tab settles ("success" | "failed" | "stopped"). */
  function finish(key, status) {
    const tab = tabs.get(key);
    if (!tab) return;
    tab.status = status;
    draw();
    onChange();
  }

  function setCancel(handler) { cancel = handler; }

  function stop(key) {
    const tab = tabs.get(key);
    if (!tab || tab.status !== "running") return;
    if (!cancel) { diag("term.noCancel"); return; }
    cancel(key, tab.name);
    diag("term.stop", { key });
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

  return { toggle, begin, ingest, finish, setCancel, stop, runningCount, start };
}
