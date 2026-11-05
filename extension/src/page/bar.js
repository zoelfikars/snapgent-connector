// SPDX-License-Identifier: GPL-3.0-or-later
// The control bar: a narrow column in a corner of the window with the agent's status, Start / Stop, the pills that choose the target,
// the approval mode and the workspace, and the "switch AI" menu; a small button beside it shows or hides it. It never attaches to
// the site's own layout. Also owns the other things the page shows the user: notices, toasts, the first-run card and the cover over
// the composer while the agent types.

import {
  computeBarView, createBarPlacer, createInputCover, createNotifications, createSetupCard, pillHtml, shouldShowSetup, applyTheme,
  computeMenuPlacement, applyMenuPlacement, viewportOf,
} from "../ui/index.js";
import { createBarMenus } from "./bar-menus.js";
import { createFilesMenu } from "./files-menu.js";
import { createMenuGroup } from "./pill-menu.js";
import { createSiteMenu } from "./site-menu.js";

const GITHUB_URL = "https://github.com/zoelfikarshomelab/snapgent-connector";
const BOLT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const pill = (id, nameId, label, title = "", popup) => pillHtml({ id, nameId, label, title, popup });
const TEMPLATE = `
  <div id="zs-bar">
    <span id="zs-state"></span>
    <button id="zs-action"></button>
    <button id="zs-stop" hidden>■ Stop</button>
    ${pill("zs-mode-btn", "zs-mode-name", "Choose how risky actions are approved", "Plan: read only. Manual: asks first. Auto: never asks.")}
    ${pill("zs-ws-btn", "zs-ws-name", "Choose the workspace folder", "Which folder the agent works in")}
    ${pill("zs-files-btn", "zs-files-name", "Tag files in your message", "Pick files: their contents go with your next message")}
    ${pill("zs-target-btn", "zs-target-name", "Choose MCP target", "Choose which MCP server receives commands", "listbox")}
    ${pill("zs-switch", "zs-switch-name", "Switch AI and options", "Switch AI and options")}
  </div>
  <button id="zs-stop-float" type="button" hidden>■ Stop</button>
  <button id="zs-toggle" type="button" aria-label="Show or hide snapgent">${BOLT}</button>
  <div id="zs-menu" hidden></div><div id="zs-target-menu" hidden></div><div id="zs-mode-menu" hidden></div><div id="zs-ws-menu" hidden></div><div id="zs-files-menu" hidden></div>`;

/**
 * @param {{ document: Document, window: Window, provider: object, state: object, settings: object, serverDirectory: object, tools: object,
 *           monitor: object, storage: object, preferences: object, send: Function, calibration: object, files: object, onStart: () => void, onStop: () => void }} deps
 */
export function createBar({ document, window, provider, state, settings, serverDirectory, tools, monitor, storage, preferences, send, calibration, files, onStart, onStop }) {
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
  const filesMenu = createFilesMenu({ document, root, group, state, settings, files, toast: notifications.toast });
  const siteMenu = createSiteMenu({
    document, window, menu: el.menu, button: $("#zs-switch"), group, provider, settings, serverDirectory, skills: tools.skills, calibration, barPrefs, preferences,
    refreshTarget: () => menus.sync(),
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
  function render() {
    menus.sync();
    filesMenu.sync();
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
  el.stop.addEventListener("click", onStop);
  el.stopFloat.addEventListener("click", (event) => { event.stopPropagation(); el.stop.click(); }); // the same Stop, reachable while the bar is hidden

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
        el.stop.textContent = "■ Stop";
        delete el.stop.dataset.state;
      }
      if (was !== el.stop.hidden) render();
    },
    /** The moment Stop is clicked, so the user sees it registered while the loop winds down. */
    markStopping() {
      el.stop.hidden = false;
      el.stop.disabled = true;
      el.stop.dataset.state = "stopping";
      el.stop.textContent = "⏳ Stopping…";
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
