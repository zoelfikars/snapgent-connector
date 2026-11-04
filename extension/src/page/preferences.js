// SPDX-License-Identifier: GPL-3.0-or-later
// The user's preferences that the preferences panel edits: how big one message may be, how many commands one reply may carry, and which
// folders are left out of the files that can be attached. All are kept in the extension's storage, the same on every site; the message
// size and the command count are read by message-budget.js from the same keys.

import { DEFAULT_BATCH_CALLS, DEFAULT_EXCLUDED_FOLDERS, clampBatchCalls, clampExcludedFolders, clampPromptChars } from "../domain/index.js";

export const KEYS = { chars: "zsMaxPromptChars", calls: "zsMaxBatchCalls", folders: "zsExcludedFolders" };

/** @param {{ storage: object, state: object }} deps  `state.filesChangedAt` is bumped when the excluded folders change: the file list is then out of date */
export function createPreferences({ storage, state }) {
  let folders = [...DEFAULT_EXCLUDED_FOLDERS];
  const load = (saved) => { folders = clampExcludedFolders(saved); };
  storage.get(KEYS.folders).then(load);
  storage.watch(KEYS.folders, (saved) => { load(saved); state.filesChangedAt = Date.now(); });

  return {
    /** The folder names to leave out of the attachable files, as saved (the defaults until the user changes them). */
    excludedFolders: () => folders,
    /** What the panel shows. */
    async read() {
      const [chars, calls, saved] = await Promise.all([storage.get(KEYS.chars), storage.get(KEYS.calls), storage.get(KEYS.folders)]);
      return { chars: clampPromptChars(chars), calls: clampBatchCalls(calls ?? DEFAULT_BATCH_CALLS), folders: clampExcludedFolders(saved) };
    },
    setChars: (value) => storage.set(KEYS.chars, clampPromptChars(value)),
    setCalls: (value) => storage.set(KEYS.calls, clampBatchCalls(value)),
    setFolders(list) {
      folders = clampExcludedFolders(list);
      state.filesChangedAt = Date.now();
      storage.set(KEYS.folders, folders);
    },
    defaultFolders: () => [...DEFAULT_EXCLUDED_FOLDERS],
  };
}
