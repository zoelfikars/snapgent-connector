// SPDX-License-Identifier: GPL-3.0-or-later
// The user's choices that the page keeps in extension storage and applies on every site: which MCP server is the target, how
// risky actions are approved, whether the first-run card was dismissed.

import { APPROVAL_MODES } from "../ui/index.js";

const KEYS = { target: "zsSelectedMcpTarget", mode: "zsApprovalMode", setupSeen: "zsSetupSeen", atPopup: "zsAtPopup" };
const isMode = (id) => APPROVAL_MODES.some((mode) => mode.id === id);

/** @param {{ storage: object, location: Location, onChange: () => void }} deps `onChange` is called whenever a loaded or changed value should be redrawn */
export function createSettings({ storage, location, onChange }) {
  let target = "vscode";
  let approvalMode = "manual"; // plan (read only) / manual (asks first) / auto (never asks); sent with each call, the model cannot set it
  let setupSeen = false;
  let atPopup = true; // the file list that opens when the user types @ in the composer

  const loaded = [
    storage.get(KEYS.target).then((saved) => { if (typeof saved === "string" && saved) { target = saved; onChange(); } }),
    storage.get(KEYS.mode).then((saved) => { if (isMode(saved)) { approvalMode = saved; onChange(); } }),
    storage.get(KEYS.setupSeen).then((saved) => { setupSeen = !!saved; }),
    storage.get(KEYS.atPopup).then((saved) => { atPopup = saved !== false; }),
  ];
  storage.watch(KEYS.mode, (saved) => { if (isMode(saved)) { approvalMode = saved; onChange(); } });
  storage.watch(KEYS.atPopup, (saved) => { atPopup = saved !== false; });

  return {
    /** Resolves once the saved choices are loaded (the first bridge status must be read against the saved target). */
    ready: Promise.all(loaded),
    target: () => target,
    /** Switching restarts the page: everything (tools, prompt) is rebuilt against the newly selected server. */
    async selectTarget(id) {
      target = id || "vscode";
      await storage.commit(KEYS.target, target);
      try { location.reload(); } catch { /* the page is going away */ }
    },
    approvalMode: () => approvalMode,
    setApprovalMode(id) {
      if (!isMode(id)) return;
      approvalMode = id;
      storage.set(KEYS.mode, id);
      onChange();
    },
    atPopup: () => atPopup,
    setAtPopup(on) { atPopup = !!on; storage.set(KEYS.atPopup, atPopup); },
    setupSeen: () => setupSeen,
    markSetupSeen() { setupSeen = true; storage.set(KEYS.setupSeen, true); },
  };
}
