// SPDX-License-Identifier: GPL-3.0-or-later
// What the page knows about the bridge: the status the background worker pushes and the page polls, whether a workspace is open,
// and the messages the toolbar popup sends to the page.

import { BridgeMonitor } from "../application/index.js";
import { bareToolName } from "../domain/tools/names.js";

const POLL_MS = 10000;

/** @param {{ state: object, settings: object, tools: object, send: Function, bar: () => object, diag: Function }} deps `bar` is a getter: the bar is made later */
export function createBridgeStatus({ state, settings, tools, send, bar, diag }) {
  const monitor = new BridgeMonitor({
    ensureTools: () => tools.catalogue.ensure(false),
    activeTools: () => tools.catalogue.active(),
    listRoot: (name, timeout) => send({ type: "call_tool", name, arguments: tools.workspace.withRoot({ path: ".", max_depth: 0 }), timeout }),
    isListTool: (name) => bareToolName(name) === "tree",
    onChange: () => bar().render(),
    log: (...args) => console.warn("[snapgentV3]", ...args),
  });

  let poll = 0;
  function apply(status) {
    if (!status) return;
    // An orphaned page gets a failure object whose `connected` is undefined, which would read as "the bridge just dropped" and
    // send the user to fix a bridge that is perfectly healthy. Say the right thing once, and stop polling: it never comes back.
    if (status.kind === "stale-extension") {
      clearInterval(poll);
      bar().showStaleExtension();
      diag("bridge.staleExtension", { via: "status", error: status.error });
      return;
    }
    state.bridge = status;
    const health = monitor.update(status, settings.target());
    bar().bridgeChanged({ connected: !!status.connected, lost: health.lost });
  }

  return {
    monitor,
    start() {
      try {
        chrome.runtime.onMessage.addListener((message) => {
          if (!message) return;
          if (message.type === "zs-status") apply({ connected: message.connected, mcpAlive: message.mcpAlive, needsApproval: message.needsApproval, tools: message.tools, servers: message.servers });
          if (message.type === "zs-open-menu") bar().openMenu(false); // the popup's Settings button
        });
      } catch { /* no extension messaging here */ }
      const refresh = () => send({ type: "status" }).then(apply);
      refresh();
      poll = setInterval(refresh, POLL_MS);
    },
  };
}
