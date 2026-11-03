// SPDX-License-Identifier: GPL-3.0-or-later
// A breadcrumb log of the agent's decisions, kept in memory (the last 300), printed to the console as `[zs-diag]` and
// mirrored into a hidden <script id="zs-diag-log"> so it can be copied from the page.

const MAX_ENTRIES = 300;

/** @returns {(event: string, data?: object) => void} */
export function createDiagnostics({ provider, state, document, window }) {
  const entries = [];
  return function diag(event, data) {
    const snapshot = { ...provider.snapshot(), gen: provider.isGenerating(), run: state.running };
    const entry = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event, data: data || null, snap: snapshot };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    try { console.log("[zs-diag]", entry.iso, event, JSON.stringify({ ...data, ...snapshot })); } catch { /* unserialisable */ }
    try {
      let node = document.getElementById("zs-diag-log");
      if (!node) {
        node = document.createElement("script");
        node.type = "application/json";
        node.id = "zs-diag-log";
        (document.body || document.documentElement).appendChild(node);
      }
      node.textContent = JSON.stringify(entries);
      window.__zsDiag = entries;
    } catch { /* the page took our node away */ }
  };
}

/** A gap far longer than the tick means the page's main thread was blocked, which looks like a hung tool. */
export function watchForStalls({ diag, state, setInterval }) {
  const TICK_MS = 250;
  const STALL_MS = 800;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > STALL_MS) diag("stall.detected", { ms: gap, overBy: gap - TICK_MS, toolRunning: state.toolRunning, running: state.running, injecting: state.injecting });
  }, TICK_MS);
}
