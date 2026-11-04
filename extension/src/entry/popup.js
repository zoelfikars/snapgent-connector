// SPDX-License-Identifier: GPL-3.0-or-later
import { allHostnames } from "../sites/registry.js";
import { MAX_BATCH_CALLS, MAX_PROMPT_CHARS, MIN_BATCH_CALLS, MIN_PROMPT_CHARS, clampBatchCalls, clampPromptChars } from "../domain/prompt/budget.js";

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
    : s.needsApproval ? "Approve in the bridge terminal" : "Bridge offline";
  const ver = document.getElementById("ver");
  const extVer = chrome.runtime.getManifest().version;
  ver.textContent = !s.connected ? `ext v${extVer}`
    : s.bridgeVersion ? `ext v${extVer} · bridge v${s.bridgeVersion}`
    : `ext v${extVer} · bridge old`;
  tools.textContent = s.connected ? `${s.tools || 0} tools` : s.needsApproval ? "Answer the question in the bridge terminal" : "Start the bridge";
  servers.textContent = s.connected
    ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`).join("\n")
    : "";
}

// The most one message into the chat may hold (read by the page; see src/page/message-budget.js).
const LIMIT_STEP = 10000;
const limitInput = document.getElementById("limit");
const limitValue = document.getElementById("limit-value");
const showLimit = (chars) => { limitValue.textContent = `${Math.round(chars / 1000)}k chars (~${Math.round(chars / 4000)}k tokens)`; };
limitInput.min = String(MIN_PROMPT_CHARS);
limitInput.max = String(MAX_PROMPT_CHARS);
limitInput.step = String(LIMIT_STEP);
chrome.storage.local.get("zsMaxPromptChars", (r) => {
  const chars = clampPromptChars(r && r.zsMaxPromptChars);
  limitInput.value = String(chars);
  showLimit(chars);
});
limitInput.addEventListener("input", () => showLimit(Number(limitInput.value)));
limitInput.addEventListener("change", () => chrome.storage.local.set({ zsMaxPromptChars: clampPromptChars(limitInput.value) }));

// How many commands one reply of the AI may carry (read by the page; see src/page/message-budget.js).
const callsInput = document.getElementById("calls");
const callsValue = document.getElementById("calls-value");
const showCalls = (count) => { callsValue.textContent = `${count} command${count === 1 ? "" : "s"}`; };
callsInput.min = String(MIN_BATCH_CALLS);
callsInput.max = String(MAX_BATCH_CALLS);
callsInput.step = "1";
chrome.storage.local.get("zsMaxBatchCalls", (r) => {
  const count = clampBatchCalls(r && r.zsMaxBatchCalls);
  callsInput.value = String(count);
  showCalls(count);
});
callsInput.addEventListener("input", () => showCalls(Number(callsInput.value)));
callsInput.addEventListener("change", () => chrome.storage.local.set({ zsMaxBatchCalls: clampBatchCalls(callsInput.value) }));

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
