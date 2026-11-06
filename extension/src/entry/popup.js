// SPDX-License-Identifier: GPL-3.0-or-later
import { accountHostsOf, allHostnames, siteFor } from "../sites/registry.js";
import { nameProblem } from "../domain/accounts/account.js";
import { matchingTab } from "../application/account-tab.js";

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

// ── accounts: which login a site uses, and switching between them ─────────────────────────────────────────────────────────
// Only a site that offers accounts (registry.js `accounts`) has this section. Cookies are read and written by the background
// worker alone; this popup asks it to. Switching is refused while an agent is running on that site: its chat would be left
// talking to a session that is no longer there.
const accounts = { supported: false, site: null, entry: null, hosts: [], active: null, list: [], busy: false };  // `site`: the id messages use; `entry`: the registry entry (its matches find the tab)
const $ = (id) => document.getElementById(id);
const say = (text, kind = "") => { const el = $("acc-status"); el.textContent = text || ""; el.dataset.kind = kind; };

function sendTo(message) {
  return new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (reply) => resolve(reply || { ok: false, error: "no response" })); } catch (error) { resolve({ ok: false, error: String((error && error.message) || error) }); }
  });
}

function tabFor(entry) {
  return new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    resolve(matchingTab(entry, tabs));
  }));
}

function drawAccounts() {
  const box = $("accounts");
  box.hidden = !accounts.supported;
  $("user").hidden = !accounts.supported;
  if (!accounts.supported) return;
  const list = $("acc-list");
  list.innerHTML = "";
  for (const account of accounts.list) {
    const row = document.createElement("div");
    row.className = "acc-row" + (account.id === accounts.active ? " is-active" : "");
    const name = document.createElement("span");
    name.className = "acc-name";
    name.textContent = account.name;
    const meta = document.createElement("span");
    meta.className = "acc-meta";
    meta.textContent = account.id === accounts.active ? "in use" : `${account.cookies} cookies`;
    const use = document.createElement("button");
    use.textContent = account.id === accounts.active ? "↻ Reload" : "Switch";
    use.disabled = accounts.busy; // the account in use can be reloaded: it is written back the same way
    use.addEventListener("click", () => activate(account));
    const forget = document.createElement("button");
    forget.textContent = "✕";
    forget.title = `Forget ${account.name}`;
    forget.disabled = accounts.busy;
    forget.addEventListener("click", () => remove(account));
    row.append(name, meta, use, forget);
    list.appendChild(row);
  }
  if (!accounts.list.length) {
    const none = document.createElement("p");
    none.className = "acc-none";
    none.textContent = "No login saved yet. Save the one this site is using now.";
    list.appendChild(none);
  }
  const busy = $("acc-busy");
  busy.hidden = !accounts.busy;
}

async function loadAccounts() {
  const reply = await sendTo({ type: "accounts_list", site: accounts.site, hosts: accounts.hosts });
  if (!reply.ok) { say(reply.error || "Could not read the saved logins.", "bad"); return; }
  accounts.active = reply.active;
  accounts.list = reply.accounts || [];
  drawAccounts();
}

async function activate(account) {
  // Everything here may throw (a tab query, a browser API): say so and clear the spinner, never leave the popup looking idle.
  accounts.busy = true;
  drawAccounts();
  try {
    const tab = await tabFor(accounts.entry);
    if (tab) {
      const state = await new Promise((resolve) => {
        try { chrome.tabs.sendMessage(tab.id, { type: "zs-account-status" }, (reply) => { void chrome.runtime.lastError; resolve(reply || {}); }); } catch { resolve({}); }
      });
      if (state.busy) { say("The agent is running in this chat. Stop it (or wait) before switching logins.", "warn"); return; }
    }
    say(`Switching to ${account.name}…`);
    const reply = await sendTo({ type: "accounts_activate", site: accounts.site, hosts: accounts.hosts, id: account.id });
    if (!reply.ok) { say(reply.error || "The switch failed.", "bad"); return; }
    const notes = [`Switched to ${account.name}.`];
    if (reply.failed && reply.failed.length) notes.push(`${reply.failed.length} cookie(s) could not be written; if the page asks you to sign in, save this login again.`);
    say(notes.join(" "), reply.failed && reply.failed.length ? "warn" : "ok");
    await loadAccounts();
  } catch (error) {
    say(`The switch failed: ${(error && error.message) || error}`, "bad");
  } finally {
    accounts.busy = false;
    drawAccounts();
  }
}

async function remove(account) {
  const reply = await sendTo({ type: "accounts_remove", site: accounts.site, hosts: accounts.hosts, id: account.id });
  if (!reply.ok) { say(reply.error || "Could not forget that login.", "bad"); return; }
  say(`Forgot ${account.name}.`);
  await loadAccounts();
}

$("acc-save").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("acc-name").value;
  const problem = nameProblem(name);
  if (problem) { say(problem, "warn"); return; }
  accounts.busy = true;
  drawAccounts();
  const reply = await sendTo({ type: "accounts_capture", site: accounts.site, hosts: accounts.hosts, name });
  accounts.busy = false;
  if (!reply.ok) { say(reply.error || "Could not save this login.", "bad"); drawAccounts(); return; }
  $("acc-name").value = "";
  say(`Saved as ${name.trim()}.`);
  await loadAccounts();
});

// Sign out of this browser only (the server session stays alive), so another account can be logged in without losing the saved one.
$("acc-other").addEventListener("click", async () => {
  accounts.busy = true;
  drawAccounts();
  try {
    say("Signing this browser out…");
    const reply = await sendTo({ type: "accounts_signout", site: accounts.site, hosts: accounts.hosts });
    if (!reply.ok) { say(reply.error || "Could not clear this browser's session.", "bad"); return; }
    say("Signed out in this browser only. Log in with the other account, then save it here.", "ok");
    await loadAccounts();
  } catch (error) {
    say(`Could not sign out: ${(error && error.message) || error}`, "bad");
  } finally {
    accounts.busy = false;
    drawAccounts();
  }
});

// What the background can actually see: the fastest way to tell a wrong host from a cookie that will not be written.
$("acc-diag").addEventListener("click", async () => {
  const out = $("acc-diag-out");
  if (!out.hidden) { out.hidden = true; return; }
  const reply = await sendTo({ type: "accounts_inspect", site: accounts.site, hosts: accounts.hosts });
  out.hidden = false;
  out.textContent = reply.ok
    ? reply.hosts.map((host) => `${host.host}\n  ${host.names.length ? host.names.join(", ") : "(no cookies)"}`).join("\n") + `\nsaved: ${accounts.list.map((a) => `${a.name} (${a.cookies})`).join(", ") || "none"}\nin use: ${accounts.active || "unknown"}`
    : `Could not inspect: ${reply.error || "unknown error"}`;
});

$("user").addEventListener("click", () => { $("accounts").hidden = !$("accounts").hidden; });

function setupAccounts() {
  return new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
    const supported = tabs.map((tab) => (tab.url ? siteFor(new URL(tab.url).hostname) : null)).find((site) => site && site.accounts);
    if (!supported) { drawAccounts(); resolve(); return; }
    accounts.supported = true;
    accounts.site = supported.id;
    accounts.entry = supported;
    accounts.hosts = accountHostsOf(supported);
    $("user-name").textContent = supported.name;
    drawAccounts();
    loadAccounts().then(resolve);
  }));
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
setupAccounts();
refresh();
setInterval(refresh, 2000);
