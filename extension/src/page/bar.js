// SPDX-License-Identifier: GPL-3.0-or-later
// The control bar: a narrow column in a corner of the window with the agent's status, Start / Stop, the pills that choose the target,
// the approval mode and the workspace, and the "switch AI" menu; a small button beside it shows or hides it. It never attaches to
// the site's own layout. Also owns the other things the page shows the user: notices, toasts, the first-run card and the cover over
// the composer while the agent types.

import {
  computeBarView, createBarPlacer, createInputCover, createNotifications, createSetupCard, openPreferences, pillHtml, shouldShowSetup, applyTheme,
  computeMenuPlacement, applyMenuPlacement, viewportOf,
} from "../ui/index.js";
import { isWorkspaceServer } from "../domain/agent/session-start.js";
import { createBarMenus } from "./bar-menus.js";
import { createFilesMenu } from "./files-menu.js";
import { createMenuGroup } from "./pill-menu.js";
import { createSiteMenu } from "./site-menu.js";

const GITHUB_URL = "https://github.com/zoelfikarshomelab/snapgent-connector";
const BOLT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const TERM = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
const GEAR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const FILES = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
const pill = (id, nameId, label, title = "", popup) => pillHtml({ id, nameId, label, title, popup });
const TEMPLATE = `
  <div id="zs-bar">
    <span id="zs-state"></span>
    <button id="zs-action"></button>
    <div id="zs-tools">
      <button id="zs-term-btn" type="button" aria-label="Terminal: commands running in this chat" title="Terminal: see what the running command prints, and stop it">${TERM}<span id="zs-term-badge" hidden></span></button>
      <button id="zs-files-btn" type="button" aria-haspopup="menu" aria-label="Files: tag files in your message" title="Pick files: their contents go with your next message">${FILES}<span id="zs-files-badge" hidden></span></button>
      <button id="zs-prefs-btn" type="button" aria-label="Preferences" title="Preferences">${GEAR}</button>
      <button id="zs-stop" type="button" hidden aria-label="Stop" title="Stop">■</button>
    </div>
    ${pill("zs-mode-btn", "zs-mode-name", "Choose how risky actions are approved", "Plan: read only. Manual: asks first. Auto: never asks.")}
    ${pill("zs-ws-btn", "zs-ws-name", "Choose the workspace folder", "Which folder the agent works in")}
    ${pill("zs-target-btn", "zs-target-name", "Choose MCP target", "Choose which MCP server receives commands", "listbox")}
    ${pill("zs-switch", "zs-switch-name", "Switch AI and options", "Switch AI and options")}
  </div>
  <button id="zs-stop-float" type="button" hidden aria-label="Stop" title="Stop">■</button>
  <button id="zs-toggle" type="button" aria-label="Show or hide snapgent">${BOLT}</button>
  <div id="zs-menu" hidden></div><div id="zs-target-menu" hidden></div><div id="zs-mode-menu" hidden></div><div id="zs-ws-menu" hidden></div><div id="zs-files-menu" hidden></div>`;

/**
 * @param {{ document: Document, window: Window, provider: object, state: object, settings: object, serverDirectory: object, tools: object,
 *           monitor: object, storage: object, preferences: object, send: Function, calibration: object, files: object, onStart: () => void, onStop: () => void }} deps
 */
export function createBar({ document, window, provider, state, settings, serverDirectory, tools, monitor, storage, preferences, send, calibration, terminal, files, onStart, onStop }) {
  const root = document.createElement("div");
  root.id = "zs-root";
  const notifications = createNotifications({ root });
  root.innerHTML = TEMPLATE;
  document.documentElement.appendChild(root);
  const $ = (selector) => root.querySelector(selector);
  const el = { bar: $("#zs-bar"), state: $("#zs-state"), action: $("#zs-action"), stop: $("#zs-stop"), stopFloat: $("#zs-stop-float"), toggle: $("#zs-toggle"), menu: $("#zs-menu") };

  // Where the bar sits and whether it is shown: the user's choice, the same on every site.
  let prefs = { corner: "bottom", hidden: false };
  storage.get("zsBarPrefs").then((saved) => { if (saved) prefs = { ...prefs, ...saved }; });
  storage.watch("zsBarPrefs", (saved) => { prefs = { ...prefs, ...saved }; });
  const barPrefs = { get: () => prefs, set(change) { prefs = { ...prefs, ...change }; storage.set("zsBarPrefs", prefs); } };
  el.toggle.addEventListener("click", (event) => { event.stopPropagation(); barPrefs.set({ hidden: !prefs.hidden }); });

  const group = createMenuGroup();
  const menus = createBarMenus({ document, root, group, settings, serverDirectory, send, confirm: tools.confirm, catalogue: tools.catalogue, workspace: tools.workspace, monitor, toast: notifications.toast });
  // Preferences is opened from the gear and from the Files window: the bar's own options and this site's calibration live there.
  const prefsActions = () => ({
    onToggleCorner: () => barPrefs.set({ corner: prefs.corner === "top" ? "bottom" : "top" }),
    onHideBar: () => barPrefs.set({ hidden: true }),
    onCalibrate: () => calibration.open(null),
    onExportCal: calibration.exportProfile,
    onImportCal: calibration.importProfile,
    onCopyDiag: calibration.copyDiagnostics,
    onRemoveCal: calibration.remove,
    onExportAll: calibration.exportAll,
    onImportAll: calibration.importAll,
  });
  const prefsValues = () => preferences.read();
  const filesMenu = createFilesMenu({
    document, root, group, state, settings, files, preferences, toast: notifications.toast,
    openPreferences: async () => openPreferences({
      document, values: await prefsValues(), defaults: { folders: preferences.defaultFolders() },
      save: { chars: preferences.setChars, calls: preferences.setCalls, folders: preferences.setFolders },
      corner: prefs.corner,
      actions: prefsActions(),
    }),
  });
  const isWorkspaceTarget = () => isWorkspaceServer(settings.target(), tools.catalogue ? tools.catalogue.active().map((t) => t.name) : []);
  const siteMenu = createSiteMenu({
    document, window, menu: el.menu, button: $("#zs-switch"), group, provider, settings, serverDirectory, skills: tools.skills, calibration, barPrefs, preferences,
    refreshTarget: () => menus.sync(), isWorkspaceTarget,
  });
  $("#zs-switch-name").textContent = provider.displayName || provider.id;

  const cover = createInputCover({ document, provider });
  const setup = createSetupCard({ document, githubUrl: GITHUB_URL, onDismiss: () => settings.markSetupSeen() });

  const placer = createBarPlacer({
    document, provider, prefs: barPrefs.get,
    parts: () => ({ bar: el.bar, root, menuEl: el.menu, toggleEl: el.toggle, stopEl: el.stop, stopFloatEl: el.stopFloat }),
    positionMenu: (anchor) => {
      if (el.menu.hidden) return;
      applyMenuPlacement(el.menu, computeMenuPlacement({ anchor, menuWidth: el.menu.offsetWidth, defaultWidth: 274, viewport: viewportOf(document, window), align: "right", roomAbove: 180 }));
    },
  });
  (function place() { window.requestAnimationFrame(place); placer.place(); })(); // scheduled first, so a throw cannot stop the loop

  // ── what the bar says ──
  let lastSignature = "";
  let lastTermCount = -1;
  function render() {
    menus.sync();
    filesMenu.sync();
    // The terminal pill carries a count of the commands still running, however the bar otherwise looks.
    const running = terminal ? terminal.runningCount() : 0;
    if (running !== lastTermCount) {
      const badge = $("#zs-term-badge");
      badge.hidden = running === 0;
      badge.textContent = running ? String(running) : "";
      lastTermCount = running;
    }
    const view = computeBarView({
      staleExtension: state.staleExtension, starting: state.starting, started: state.started, running: state.running, parked: state.parked,
      blankChat: !state.started && !state.starting && !state.staleExtension && (provider.isFreshChat() || provider.chatIsEmpty()),
      bridge: state.bridge, bridgeOk: monitor.bridgeOk,
      target: { id: settings.target(), name: serverDirectory.name(settings.target()) },
      activeToolCount: tools.catalogue.active().length,
      workspaceReady: monitor.workspaceReady, workspaceProbePending: monitor.workspaceProbePending, workspaceFolder: tools.workspace.bound(),
      modeWarning: !state.started && !state.starting && provider.modeWarning ? provider.modeWarning() : null,
      needsCalibration: !!provider.needsCalibration,
    });
    const busy = !el.stop.hidden;
    // Only touch the DOM when something changed: rewriting the status restarts the spinner's CSS animation.
    const signature = [view.tone, view.spinner, view.message, view.label, view.kind, view.disabled, view.warn, busy].join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    el.bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
    el.bar.classList.add(`tone-${view.tone}`);
    el.state.innerHTML = `${view.spinner ? `<span class="zs-spin"></span>` : ""}<span class="zs-state-txt">${view.message}</span>`;
    el.state.classList.toggle("zs-state-warn", view.warn);
    el.action.textContent = view.label;
    el.action.dataset.kind = view.kind;
    el.action.disabled = view.disabled;
    el.action.style.display = busy || !view.kind ? "none" : ""; // Stop takes the action button's place while the agent is busy
  }

  el.action.addEventListener("click", () => {
    if (el.action.dataset.kind === "start") onStart();
    else if (el.action.dataset.kind === "calibrate") {
      // A part that stopped matching is redone on its own; a site never calibrated is done from the start.
      const problem = provider.health && provider.health().problems[0];
      calibration.open(problem && ["composer", "send"].includes(problem.role) ? problem.role : null);
    }
  });
  el.term = $("#zs-term-btn");
  el.term.addEventListener("click", (event) => { event.stopPropagation(); if (terminal) terminal.toggle(); });
  el.stop.addEventListener("click", onStop);
  el.stopFloat.addEventListener("click", (event) => { event.stopPropagation(); el.stop.click(); }); // the same Stop, reachable while the bar is hidden

  $("#zs-prefs-btn").addEventListener("click", async (event) => {
    event.stopPropagation();
    openPreferences({
      document, values: await prefsValues(), defaults: { folders: preferences.defaultFolders() },
      save: { chars: preferences.setChars, calls: preferences.setCalls, folders: preferences.setFolders },
      corner: prefs.corner, actions: prefsActions(),
    });
  });

  applyTheme(document);
  setInterval(() => applyTheme(document), 4000); // follow the host page toggling its theme
  document.addEventListener("zs-provider-changed", render);
  render();

  let nudged = false;
  return {
    render,
    root,
    cover: cover.set,
    coverLabel: cover.setLabel,
    toast: (text) => notifications.toast(text),
    banner: (level, title, text) => notifications.banner(level, title, text),
    openMenu: (toSupport) => { if (el.menu.hidden) siteMenu.toggle(toSupport); },

    /** Stop is shown while the agent is busy; it stays through the wind-down so it does not blink as the site's signals flicker. */
    showStop(visible) {
      const allow = (visible || state.stopping) && !state.starting;
      const was = el.stop.hidden;
      el.stop.hidden = !allow;
      if (allow && !state.stopping && el.stop.dataset.state === "stopping") {
        el.stop.disabled = false;
        el.stop.textContent = "■";
        el.stop.title = "Stop"; el.stop.setAttribute("aria-label", "Stop");
        el.stopFloat.textContent = "■";
        delete el.stop.dataset.state;
      }
      if (was !== el.stop.hidden) render();
    },
    /** The moment Stop is clicked, so the user sees it registered while the loop winds down. */
    markStopping() {
      el.stop.hidden = false;
      el.stop.disabled = true;
      el.stop.dataset.state = "stopping";
      el.stop.textContent = "⏳";
      el.stop.title = "Stopping…"; el.stop.setAttribute("aria-label", "Stopping…");
      el.stopFloat.textContent = "⏳";
      render();
    },
    /** The user typed in a fresh chat without starting the agent: plain chat is fine, so only point at Start, once. */
    nudgeStart() {
      if (state.started || !provider.isFreshChat()) return;
      if (!nudged) { nudged = true; notifications.toast("Click “▶︎ Start” to begin."); }
      el.action.classList.add("zs-flash");
      setTimeout(() => el.action.classList.remove("zs-flash"), 1200);
    },
    /** The bridge status changed: `lost` means it was connected a moment ago and is not any more. */
    bridgeChanged({ connected, lost }) {
      if (lost) notifications.setBridgeLost(true);
      if (connected) {
        notifications.setBridgeLost(false);
        if (!settings.setupSeen()) settings.markSetupSeen();
      }
      render();
      const show = shouldShowSetup({ dismissed: settings.setupSeen(), bridgeConnected: connected, hasSession: state.started || state.starting, chatIsEmpty: provider.chatIsEmpty() });
      if (show) setup.show(); else setup.hide();
    },
    /** The page outlived its extension build. Unlike a bridge outage this never heals: no Close button, only the reload. */
    showStaleExtension() {
      state.staleExtension = true; // latched BEFORE painting, so the bar drops its frozen "Agent active" in the same pass
      render();
      notifications.showStaleExtension();
    },
  };
}
