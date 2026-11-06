// SPDX-License-Identifier: GPL-3.0-or-later
// Typing @ in the composer opens the list of the workspace's files beside it. What is typed after the @ is the search; choosing a
// file puts `@path` in its place (the same tag the Files pill inserts, attached on send, see attachments.js). The list can be
// closed (✕, Esc, a click elsewhere) or turned off for good; it never takes the keyboard from the composer except while it is open.
//
// Only the tag at the END of the text is looked at: the caret position inside a site's editor cannot be read reliably.

import { matchPaths, trailingTag } from "../domain/prompt/file-tags.js";
import { applyMenuPlacement, atPopupHtml, computeMenuPlacement, openPreferences, viewportOf } from "../ui/index.js";
import { createFileList } from "./file-list.js";

const SHOWN = 60;
const PREFETCH_MS = 2500;

/** @param {{ document: Document, window: Window, root: HTMLElement, state: object, settings: object, provider: object, attachments: object, toast: (text: string) => void, diag: Function }} deps */
export function createAtPopup({ document, window, root, state, settings, provider, attachments, preferences, calibration, barPrefs, toast, diag }) {
  const el = document.createElement("div");
  el.id = "zs-at-popup";
  el.hidden = true;
  el.innerHTML = atPopupHtml();
  root.appendChild(el);
  const list = createFileList({ element: el.querySelector(".zs-at-list"), max: SHOWN, onPick: (path) => pick(path) });

  let paths = [];
  let tag = null;
  let text = "";
  let dismissed = null; // the tag the user closed the list for: it stays closed until that tag is gone

  // `canList` is true only when the target advertises `find_files`, which only a folder-aware server does.
  const enabled = () => state.started && settings.atPopup() && attachments.canList();
  const inEditor = (node) => { const editor = provider.getEditor(); return !!editor && (node === editor || editor.contains(node)); };

  function place() {
    if (el.hidden) return;
    const anchor = provider.composerFrame() || provider.getEditor();
    if (!anchor) return;
    // The list opens exactly as wide as the composer: it reads as part of the input, not as a floating menu.
    const rect = anchor.getBoundingClientRect();
    const viewport = viewportOf(document, window);
    const width = Math.min(rect.width, viewport.width - 16);
    const placement = computeMenuPlacement({
      anchor: rect, menuWidth: width, defaultWidth: width, viewport, align: "left", roomAbove: 240,
    });
    applyMenuPlacement(el, placement);
    el.style.width = `${Math.round(width)}px`;
    window.requestAnimationFrame(place);
  }

  function showIgnored() {
    const label = el.querySelector(".zs-at-ignored-label");
    if (!label) return;
    const names = preferences && preferences.excludedFolders ? preferences.excludedFolders() : [];
    label.textContent = names.length ? `Ignored: ${names.join(", ")}` : "Nothing is ignored";
  }

  async function openPrefs() {
    close(false);
    openPreferences({
      document, values: { ...(await preferences.read()), site: calibration ? calibration.limits() : undefined }, defaults: { folders: preferences.defaultFolders(), contextFiles: preferences.defaultContextFiles() },
      save: { chars: preferences.setChars, calls: preferences.setCalls, folders: preferences.setFolders, contextFiles: preferences.setContextFiles, site: calibration && calibration.setLimits },
      corner: barPrefs ? barPrefs.get().corner : "bottom",
      actions: {
        onCalibrate: () => calibration && calibration.open(null),
        onExportCal: calibration && calibration.exportProfile,
        onImportCal: calibration && calibration.importProfile,
        onCopyDiag: calibration && calibration.copyDiagnostics,
        onRemoveCal: calibration && calibration.remove,
        onExportAll: calibration && calibration.exportAll,
        onImportAll: calibration && calibration.importAll,
        onCopyTest: calibration && calibration.copyTestText,
        onFillTest: calibration && calibration.fillTestText,
        onAttachTest: calibration && calibration.attachTestFile,
      },
    });
  }
  function close(forThisTag) {
    if (forThisTag && tag) dismissed = { start: tag.start, before: text.slice(0, tag.start) };
    el.hidden = true;
  }

  async function onInput() {
    text = provider.editorText() || "";
    const found = trailingTag(text);
    if (!found) { dismissed = null; tag = null; el.hidden = true; return; }
    if (!enabled()) { el.hidden = true; return; }
    if (dismissed && dismissed.start === found.start && text.slice(0, found.start) === dismissed.before) return;
    const opening = el.hidden;
    tag = found;
    if (!paths.length) {
      list.message("Loading files…");
      el.hidden = false;
      const listing = await attachments.listFiles();
      if (!listing.ok) { el.hidden = true; toast(listing.error); return; }
      paths = listing.paths;
      if (!tag) return; // the tag was gone while the list loaded
    } else {
      attachments.listFiles().then((listing) => { // refreshed in the background when stale; the open list follows when something changed
        if (!listing.ok) return;
        const changed = listing.paths.length !== paths.length || listing.paths.some((path, index) => path !== paths[index]);
        paths = listing.paths;
        if (changed && tag && !el.hidden) list.set(matchPaths(paths, tag.query));
      });
    }
    list.set(matchPaths(paths, tag.query));
    el.hidden = false;
    showIgnored();
    if (opening) window.requestAnimationFrame(place);
  }

  async function pick(path) {
    const at = tag;
    const typed = text;
    close(false);
    tag = null;
    if (!at) return;
    try { await attachments.replaceTag(typed, at.start, path); } catch (error) { toast(String((error && error.message) || error)); diag("at.pickFailed", { msg: String((error && error.message) || error) }); }
  }

  // Before the site and our own send hook see the key: while the list is open it owns the arrows, Enter, Tab and Esc.
  window.addEventListener("keydown", (event) => {
    if (el.hidden || event.isComposing || !inEditor(event.target)) return;
    const take = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!list.count()) return;
      take();
      list.move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (!list.count()) { close(true); return; } // nothing to insert: Enter is the user's own (send), Tab leaves the box
      take();
      pick(list.activePath());
    } else if (event.key === "Escape") {
      take();
      close(true);
    }
  }, true);

  document.addEventListener("input", (event) => { if (inEditor(event.target)) onInput(); }, true);
  // A click anywhere else closes it, without remembering: typing @ again opens it again.
  document.addEventListener("click", (event) => { if (!el.hidden && !el.contains(event.target) && !inEditor(event.target)) close(false); }, true);

  el.addEventListener("mousedown", (event) => event.preventDefault()); // the composer keeps the focus
  el.querySelector(".zs-at-x").addEventListener("click", () => close(true));
  el.querySelector(".zs-at-gear").addEventListener("click", openPrefs);
  el.querySelector(".zs-at-off").addEventListener("click", () => {
    close(false);
    settings.setAtPopup(false);
    toast("Turned off. The Files menu turns it on again.");
  });

  // The list is fetched once the session is on, so the first @ shows it at once.
  let prefetched = false;
  setInterval(() => {
    if (!enabled()) { prefetched = false; return; }
    if (prefetched) return;
    prefetched = true;
    attachments.listFiles().then((listing) => { if (listing.ok) paths = listing.paths; });
  }, PREFETCH_MS);
}
