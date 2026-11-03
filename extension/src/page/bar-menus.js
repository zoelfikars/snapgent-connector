// SPDX-License-Identifier: GPL-3.0-or-later
// The three dropdown pills that choose where the agent works and how freely: the MCP target, the approval mode (Plan / Manual /
// Auto) and the workspace folder (VS Code's active window, one of its open folders, or any folder).

import { APPROVAL_MODES, modeMenuHtml, targetMenuHtml, workspaceLabel, workspaceMenuHtml } from "../ui/index.js";
import { createPillMenu } from "./pill-menu.js";

/**
 * @param {{ document: Document, root: HTMLElement, group: object, settings: object, serverDirectory: object, send: Function,
 *           confirm: object, catalogue: object, monitor: object, toast: (text: string) => void }} deps
 * @returns {{ sync: () => void }} redraw the pills from the current settings
 */
export function createBarMenus({ document, root, group, settings, serverDirectory, send, confirm, catalogue, monitor, toast }) {
  const $ = (selector) => root.querySelector(selector);
  const make = (button, menu, width, align, roomAbove, render) => createPillMenu({ document, button: $(button), menu: $(menu), group, width, align, roomAbove, render });

  // ── the MCP target ──
  const targetMenu = make("#zs-target-btn", "#zs-target-menu", 220, "left", 160, () => {
    const menu = $("#zs-target-menu");
    const options = serverDirectory.targetOptions(settings.target());
    const key = `${settings.target()}|${options.map((option) => `${option.id}:${option.name}`).join("|")}`;
    if (menu.dataset.key === key && menu.childElementCount) return; // rewriting would destroy a button between mouse-down and mouse-up
    menu.dataset.key = key;
    menu.innerHTML = targetMenuHtml(options, settings.target());
    menu.querySelectorAll(".zs-target-opt").forEach((button) => button.addEventListener("click", () => {
      targetMenu.close();
      if (button.dataset.id !== settings.target()) settings.selectTarget(button.dataset.id);
    }));
  });

  // ── how risky actions are approved ──
  const modeMenu = make("#zs-mode-btn", "#zs-mode-menu", 280, "right", 200, () => {
    const menu = $("#zs-mode-menu");
    menu.innerHTML = modeMenuHtml(settings.approvalMode());
    menu.querySelectorAll(".zs-mode-opt").forEach((button) => button.addEventListener("click", () => chooseMode(button.dataset.id)));
  });
  async function chooseMode(id) {
    modeMenu.close();
    if (id === settings.approvalMode()) return;
    // Auto removes the safety net: ask once, in the page-proof dialog, before it takes effect.
    if (id === "auto" && !(await confirm.ask({
      description: "Switch to Auto? The agent will then delete files, make git commits and run commands in your project without asking you each time.",
      tool: "Approval mode", risk: "execute",
    }))) return;
    settings.setApprovalMode(id);
  }

  // ── the workspace folder ──
  let pinned = null;
  const renderWorkspace = () => {
    $("#zs-ws-name").textContent = workspaceLabel(pinned);
    $("#zs-ws-btn").title = pinned || "Auto: follows the active VS Code window";
  };
  const wsMenu = make("#zs-ws-btn", "#zs-ws-menu", 300, "right", 240, async () => {
    const listing = await send({ type: "workspaces" });
    if (!listing.ok) { toast(listing.error || "The bridge is not reachable."); return false; }
    pinned = listing.pinned;
    renderWorkspace();
    fillWorkspaceMenu(listing);
  });
  const wsError = (text) => { const el = $("#zs-ws-menu .zs-ws-error"); if (el) { el.textContent = text; el.hidden = !text; } };

  async function useWorkspace(path, { typed = false } = {}) {
    // A folder typed in may be anywhere on the machine: ask once before the agent may work in it.
    if (typed && !(await confirm.ask({ description: `Let the agent read and change files in this folder?\n${path}`, tool: "Workspace", risk: "write" }))) return;
    const reply = await send({ type: "set_workspace", path });
    if (!reply.ok) { wsError(reply.error || "Could not use that folder."); return; }
    pinned = reply.pinned;
    wsMenu.close();
    renderWorkspace();
    // A pinned folder is a usable workspace right away; "Auto" goes back to probing.
    monitor.workspaceReady = !!pinned;
    monitor.workspaceProbePending = false;
    catalogue.ensure(true);
    toast(pinned ? `Working in ${workspaceLabel(pinned)}` : "Following the active VS Code window");
  }

  function fillWorkspaceMenu(listing) {
    const menu = $("#zs-ws-menu");
    menu.innerHTML = workspaceMenuHtml(listing);
    menu.querySelectorAll(".zs-ws-opt").forEach((button) => button.addEventListener("click", () => useWorkspace(button.dataset.path)));
    // Typing here must not trigger the site's own keyboard shortcuts.
    const input = menu.querySelector(".zs-ws-input");
    for (const type of ["keydown", "keyup", "keypress", "input"]) input.addEventListener(type, (event) => event.stopPropagation());
    const pick = menu.querySelector(".zs-ws-pick");
    pick.addEventListener("click", async () => {
      const host = pick.querySelector(".zs-site-host");
      wsError("");
      pick.disabled = true;
      host.textContent = "waiting for the folder window…";
      const picked = await send({ type: "pick_folder" });
      pick.disabled = false;
      host.textContent = "opens your system's folder window";
      if (!picked.ok) { wsError(picked.error || "The folder window could not be opened."); menu.querySelector(".zs-ws-form").hidden = false; return; }
      if (picked.picked) useWorkspace(picked.picked); // chosen by the user in the system's own window: no second question
    });
    menu.querySelector(".zs-ws-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const typedPath = input.value.trim();
      if (typedPath) useWorkspace(typedPath, { typed: true });
    });
  }

  // The pill shows what is pinned right now (a bridge restart forgets it).
  send({ type: "workspaces" }).then((listing) => { if (listing.ok) { pinned = listing.pinned; renderWorkspace(); } });
  renderWorkspace();

  return {
    sync() {
      const options = serverDirectory.targetOptions(settings.target());
      $("#zs-target-name").textContent = (options.find((option) => option.id === settings.target()) || { name: settings.target() }).name;
      const mode = APPROVAL_MODES.find((item) => item.id === settings.approvalMode()) || APPROVAL_MODES[1];
      $("#zs-mode-name").textContent = mode.name;
      $("#zs-mode-btn").dataset.mode = mode.id;
      // Mode and folder only mean something for the VS Code server.
      const forVscode = settings.target() === "vscode";
      $("#zs-mode-btn").hidden = !forVscode;
      $("#zs-ws-btn").hidden = !forVscode;
      if (targetMenu.isOpen) targetMenu.refresh();
    },
  };
}
