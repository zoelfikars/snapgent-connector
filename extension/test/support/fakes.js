// In-memory implementations of the application ports, for tests.

export function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn, every }
  const add = (fn, ms, every) => { const id = nextId++; pending.set(id, { at: now + ms, fn, every }); return id; };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    get active() { return pending.size; },
    /** Advance time, firing due timers in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else pending.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export const tool = (name, props = {}, server) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: props, required: Object.keys(props) },
  ...(server ? { server } : {}),
});

export function fakeBridge({ tools = [], results = {} } = {}) {
  const bridge = {
    tools,
    results,
    listCalls: 0,
    calls: [],
    async listTools() { bridge.listCalls++; return { tools: bridge.tools }; },
    async callTool(request) {
      bridge.calls.push(request);
      const r = bridge.results[request.name];
      return typeof r === "function" ? r(request) : r ?? { ok: true, text: "done" };
    },
  };
  return bridge;
}

export function fakeSession(overrides = {}) {
  const state = { target: "vscode", enabled: new Set(["vscode"]), servers: [{ id: "vscode", alive: true, tools: 2 }], vision: false, stopped: false };
  Object.assign(state, overrides);
  return {
    state,
    target: () => state.target,
    isEnabled: (id) => state.enabled.has(id),
    servers: () => state.servers,
    supportsVision: () => state.vision,
    isStopped: () => state.stopped,
  };
}

export function fakeSink() {
  const sink = { images: [], stale: [], events: [] };
  return {
    log: sink,
    images: (images, name) => sink.images.push({ images, name }),
    staleExtension: (error, name) => sink.stale.push({ error, name }),
    diag: (event, data) => sink.events.push({ event, data }),
  };
}

export function fakeVisibility({ hidden = false, becomesVisible = true } = {}) {
  const v = { hidden, waits: 0 };
  return {
    state: v,
    isHidden: () => v.hidden,
    async waitUntilVisible() { v.waits++; v.hidden = false; return becomesVisible; },
  };
}
