// SPDX-License-Identifier: GPL-3.0-or-later
// What the user does about calibrating this site (docs/CALIBRATION.md): teach it, redo one part, export and import the result,
// remove it, and copy what a bug report needs.

import { ProfileStore } from "../application/index.js";
import { createCalibrationWizard } from "../ui/index.js";
import { learnProfile, profileProblems, updateProfile, createCalibratedProvider } from "../infrastructure/calibration/index.js";
import { describeElement } from "../infrastructure/chat/index.js";

/** @param {{ document: Document, location: Location, provider: object, state: object, storage: object, settings: object, toast: (text: string) => void }} deps */
export function createCalibrationActions({ document, location, provider, state, storage, settings, toast }) {
  const store = new ProfileStore({ store: { get: storage.get, set: storage.commit }, problemsOf: profileProblems });
  let wizard = null;

  /** `only` names one part to redo (composer, send, ...); null teaches the whole site. */
  async function open(only) {
    if (wizard) wizard.cancel(false);
    wizard = createCalibrationWizard({
      document, hostname: location.hostname, name: provider.displayName, current: await store.get(location.hostname),
      calibration: { learnProfile, updateProfile, createProvider: (profile) => createCalibratedProvider({ document, location, profile }) },
      onSave: (profile) => store.save(profile),
      describe: describeElement,
    });
    wizard.start({ only });
  }

  async function exportProfile() {
    const text = await store.exportText(location.hostname);
    if (!text) { toast("This site is not calibrated yet."); return; }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    link.download = `snapgent-${location.hostname}.json`;
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function importProfile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const result = await store.importText(await file.text(), location.hostname);
      toast(result.ok ? "Calibration imported." : result.error);
    });
    input.click();
  }

  async function remove() {
    await store.remove(location.hostname);
    toast("Calibration removed.");
  }

  /** What the profile finds on this page right now (elements, sizes, counts), never the chat's text. */
  async function copyDiagnostics() {
    const chain = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) parts.push(describeElement(n)); return parts.join(" < "); };
    const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    const lines = ["snapgent diagnostics", `site: ${location.hostname}${location.pathname}`, `calibrated: ${!provider.needsCalibration}`,
      `session: started=${state.started} starting=${state.starting} running=${state.running} target=${settings.target()}`];
    if (provider.diagnose) {
      const d = provider.diagnose();
      lines.push(`profile: ${JSON.stringify(d.profile)}`, `health: ${JSON.stringify(d.health)}`,
        `chatIsEmpty=${d.chatIsEmpty} isFreshChat=${d.isFreshChat} key="${d.key}" turns: ${d.userCount} yours, ${d.assistantCount} AI`);
      for (const [label, el] of [["composer", d.composer], ["card", d.card], ["send", d.send]]) lines.push(`${label}: ${el ? `${rect(el)} ${chain(el)}` : "-"}`);
      for (const role of ["user", "assistant"]) {
        lines.push(`${role} matches (first 8):`);
        for (const m of d[role]) lines.push(`  ${m.shown ? "shown" : "hidden"} ${m.chars} chars ${rect(m.el)} ${chain(m.el)}`);
      }
    }
    try { await navigator.clipboard.writeText(lines.join("\n")); toast("Diagnostics copied."); } catch { toast("Could not copy to the clipboard."); }
  }

  return { open, exportProfile, importProfile, remove, copyDiagnostics };
}
