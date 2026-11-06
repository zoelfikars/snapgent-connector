// SPDX-License-Identifier: GPL-3.0-or-later
// The part of a login that lives in the page's localStorage rather than in a cookie (DeepSeek keeps its token there). Only the
// keys the site's registry entry names can be read or written: the background asks through a message, and a message must never
// be a way to reach the rest of the page's storage.

/** @param {{ area: { getItem: Function, setItem: Function, removeItem: Function }, allowed: string[] }} deps */
export function createAccountStorage({ area, allowed }) {
  const permitted = (key) => allowed.includes(key);
  return {
    /** The values of the allowed keys that are set, as { key: text }. */
    read(keys) {
      const values = {};
      for (const key of keys || []) {
        if (!permitted(key)) continue;
        try {
          const value = area.getItem(key);
          if (value !== null && value !== undefined) values[key] = value;
        } catch { /* storage not readable here */ }
      }
      return values;
    },
    /** Set each allowed key to its text, or remove it when the value is null. Returns how many keys were touched. */
    write(entries) {
      let touched = 0;
      for (const [key, value] of Object.entries(entries || {})) {
        if (!permitted(key)) continue;
        try {
          if (value === null) area.removeItem(key);
          else if (typeof value === "string") area.setItem(key, value);
          else continue;
          touched += 1;
        } catch { /* storage not writable here */ }
      }
      return touched;
    },
  };
}
