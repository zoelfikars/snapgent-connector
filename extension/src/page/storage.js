// SPDX-License-Identifier: GPL-3.0-or-later
// chrome.storage.local the way the page uses it: promises that never reject, because a page can outlive its extension
// (reload, update) and every call then throws.

export function createStorage() {
  return {
    get: (key) => new Promise((resolve) => {
      try { chrome.storage.local.get(key, (items) => resolve(items ? items[key] : undefined)); } catch { resolve(undefined); }
    }),
    /** Fire and forget. */
    set(key, value) { try { chrome.storage.local.set({ [key]: value }); } catch { /* nothing to save to */ } },
    /** Resolves once the value is stored (for a caller that reloads the page right after). */
    commit: (key, value) => new Promise((resolve) => {
      try { chrome.storage.local.set({ [key]: value }, resolve); } catch { resolve(); }
    }),
    remove(key) { try { chrome.storage.local.remove(key); } catch { /* nothing to remove from */ } },
    /** Call `listener(newValue)` whenever another part of the extension changes `key`. */
    watch(key, listener) {
      try {
        chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[key]) listener(changes[key].newValue); });
      } catch { /* no extension storage here */ }
    },
  };
}
