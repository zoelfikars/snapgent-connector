// Scripted fakes for AgentLoop's ports.
import { ToolReminder } from "../../src/application/tool-reminder.js";
import { fakeTimers } from "./fakes.js";

export function createLoopHarness({ responses = [], runner, hidden = false, hasCatalogue = true, reminderEvery = 20, halted = false, resumeTruncated = false } = {}) {
  const log = [];            // ordered record of everything observable
  const queue = [...responses];
  const timers = fakeTimers();
  const state = { stopped: false, hidden, submitted: [] };

  const chat = {
    async next(base) { log.push(["next", base]); const r = queue.shift(); if (!r) throw new Error("no scripted response left"); return typeof r === "function" ? r(state) : r; },
    async submit(text) { state.submitted.push({ text }); log.push(["submit", text]); return `base-${state.submitted.length}`; },
    isHalted: () => halted,
    async resumeTruncated() { log.push(["resumeTruncated"]); return resumeTruncated; },
  };
  const view = {
    banner: (level, title, text) => log.push(["banner", level, title, text]),
    toast: (text) => log.push(["toast", text]),
    keepCover: () => log.push(["cover"]),
    toolRunning: (item, call) => log.push(["tool:running", call.tool]),
    toolFinished: () => log.push(["tool:finished"]),
  };
  const lifecycle = {
    start: () => log.push(["lifecycle:start"]),
    end: () => log.push(["lifecycle:end"]),
    isStopped: () => state.stopped,
    halt: () => { state.stopped = true; log.push(["lifecycle:halt"]); },
  };
  const visibility = {
    isHidden: () => state.hidden,
    async waitUntilVisible() { log.push(["waitUntilVisible"]); state.hidden = false; return true; },
  };
  const tools = {
    hasCatalogue: () => hasCatalogue,
    reminderText: () => "\n[REMINDER]",
  };
  const memory = { executed: (item) => log.push(["memory:executed", item && item.id]) };
  const outbox = { prepare: (text) => text };
  const runnerImpl = runner || { run: async (call) => `» ${call.tool}\nok` };

  return {
    state, log, timers,
    deps: {
      chat, view, lifecycle, visibility, tools, memory, outbox,
      runner: { run: (call) => { log.push(["run", call.tool]); return runnerImpl.run(call, state); } },
      reminder: new ToolReminder({ every: reminderEvery }),
      activity: { signature: () => "same", isPaused: () => false },
      timers,
      now: timers.now,
      displayName: () => "TestAI",
      diag: (event, data) => log.push(["diag", event, data]),
    },
    events: (...kinds) => log.filter((e) => kinds.includes(e[0])),
    names: () => log.map((e) => (e[0] === "diag" ? `diag:${e[1]}` : e[0])),
  };
}

export const toolTurn = (tool, args = {}, item = { id: "turn" }) => ({ kind: "tool", item, calls: [{ tool, arguments: args }] });
export const textTurn = { kind: "text", text: "all done" };
