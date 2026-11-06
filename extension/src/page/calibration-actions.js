// SPDX-License-Identifier: GPL-3.0-or-later
// What the user does about calibrating this site (docs/CALIBRATION.md): teach it, redo one part, export and import the result,
// remove it, and copy what a bug report needs.

import { ProfileStore } from "../application/index.js";
import { SITE_LINKS, siteFor } from "../sites/registry.js";
import { createCalibrationWizard, openCalibrationImport } from "../ui/index.js";
import { learnProfile, profileProblems, updateProfile, createCalibratedProvider } from "../infrastructure/calibration/index.js";
import { describeElement } from "../infrastructure/chat/index.js";
import { loremIpsum } from "../domain/prompt/lorem.js";

/** @param {{ document: Document, location: Location, provider: object, state: object, storage: object, settings: object, toast: (text: string) => void }} deps */
export function createCalibrationActions({ document, location, provider, state, storage, settings, toast }) {
  const store = new ProfileStore({
    store: { get: storage.get, set: storage.commit },
    problemsOf: profileProblems,
    siteOf: (host) => { const site = siteFor(host); return site && { id: site.id, name: site.name }; },
  });
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
    download(text, `snapgent-${location.hostname}.json`);
  }

  function download(text, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    link.download = name;
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /** Every calibration of every AI, in one file. */
  async function exportAll() {
    const text = await store.exportAllText();
    if (!text) { toast("Nothing is calibrated yet."); return; }
    download(text, "snapgent-calibrations.json");
  }

  /** Choose files, see what they hold per AI (in the order of the "switch AI" list), and take the ones ticked. */
  function importAll() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      const { groups, skipped } = await store.read(await Promise.all(files.map((file) => file.text())));
      const order = (group) => { const at = SITE_LINKS.findIndex((site) => site.name === group.name); return at < 0 ? SITE_LINKS.length : at; };
      groups.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
      openCalibrationImport({
        document, groups, skipped,
        onImport: async (ids) => {
          const chosen = groups.filter((group) => ids.includes(group.id));
          await store.saveAll(chosen.flatMap((group) => group.profiles));
          toast(chosen.length ? `Imported ${chosen.map((group) => group.name).join(", ")}.` : "Nothing was imported.");
        },
      });
    });
    input.click();
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

  /** This AI's message size and commands per reply, kept in its calibration; null goes back to the general preferences. */
  async function setLimits(limits) {
    // A site that only has the shipped calibration gets a copy of it as its own, with the limits added.
    const base = (await store.get(location.hostname)) || (provider.diagnose && provider.diagnose().profile);
    if (!base) { toast("Calibrate this site first."); return; }
    const updated = updateProfile(base, "limits", { limits });
    if (updated.error) { toast(updated.error); return; }
    const saved = await store.save(updated.profile);
    if (!saved.ok) toast(saved.error);
  }

  /** Filler text of an exact size on the clipboard, to paste into the chat when finding out how much one message it accepts. */
  async function copyTestText(chars) {
    const text = loremIpsum(chars);
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text.length.toLocaleString("en-US")} characters of test text to the clipboard.`);
    } catch { toast("Could not copy to the clipboard."); }
  }

  /** Filler text written into the text box the way the extension writes its own messages (a paste event first), and not sent. */
  async function fillTestText(chars) {
    if (provider.needsCalibration) { toast("Calibrate this site first."); return; }
    const text = loremIpsum(chars);
    try {
      const via = await provider.writeText(text);
      toast(`Wrote ${text.length.toLocaleString("en-US")} characters into the text box (via ${via}).`);
    } catch (error) { toast(String((error && error.message) || error)); }
  }

  /** Filler text as a .txt file given to the page by `method` (paste, input or drop), and not sent. */
  async function attachTestFile(chars, method) {
    if (provider.needsCalibration) { toast("Calibrate this site first."); return; }
    const text = loremIpsum(chars);
    try {
      const result = await provider.attachFile(new File([text], "test.txt", { type: "text/plain" }), method);
      toast(`Gave the page test.txt (${text.length.toLocaleString("en-US")} characters) by ${result.method}${result.handled ? "; the page reacted to it" : "; the page did not cancel the event"}. Look for an attachment chip.`);
    } catch (error) { toast(String((error && error.message) || error)); }
  }

  async function remove() {
    await store.remove(location.hostname);
    toast("Calibration removed.");
  }

  /** What the profile finds on this page right now (elements, sizes, counts), never the chat's text. */
  async function copyDiagnostics() {
    const chain = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) parts.push(describeElement(n)); return parts.join(" < "); };
    const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    const lines = ["snapgent diagnostics", `site: ${location.hostname}${location.pathname}`, `calibrated: ${!provider.needsCalibration} (${provider.calibrationSource === "default" ? "the one shipped with the extension" : provider.calibrationSource === "own" ? "your own" : "none"})`,
      `session: started=${state.started} starting=${state.starting} running=${state.running} target=${settings.target()} approval=${settings.approvalMode()}`];
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

  // undefined: not calibrated, so nothing to keep them in; null: calibrated, no values of its own.
  const limits = () => (provider.needsCalibration ? undefined : provider.limits || null);

  return { limits, setLimits, copyTestText, fillTestText, attachTestFile, open, exportProfile, importProfile, exportAll, importAll, remove, copyDiagnostics };
}
