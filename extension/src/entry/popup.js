// SPDX-License-Identifier: GPL-3.0-or-later
import { allHostnames } from "../sites/registry.js";

const SUPPORTED_HOSTS = allHostnames();
// const DEFAULT_AI_URL = "https://chat.deepseek.com/"; // DeepSeek hidden (disabled, not deleted)
const DEFAULT_AI_URL = "https://chatgpt.com/";



function render(s) {
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const dot = document.getElementById("dot");
  dot.className = "dot " + (!s.connected ? "bad" : mcpOk ? "ok" : "warn");
  state.textContent = s.connected
    ? (mcpOk ? "Connected" : "MCP server down")
    : s.needsApproval ? "Approve in the bridge window" : "Bridge offline";
  const ver = document.getElementById("ver");
  const extVer = chrome.runtime.getManifest().version;
  ver.textContent = !s.connected ? `ext v${extVer}`
    : s.bridgeVersion ? `ext v${extVer} · bridge v${s.bridgeVersion}`
    : `ext v${extVer} · bridge old`;
  tools.textContent = s.connected ? `${s.tools || 0} tools` : s.needsApproval ? "Answer the question in the bridge window" : "Start the bridge";
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart";
    setTimeout(refresh, 600);
  });
});
document.getElementById("settings").addEventListener("click", () => {
  // Tries the in-page panel on an already-open supported AI tab first, so
  // opening it doesn't require a conversation to already be started there.
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "zs-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
