// SPDX-License-Identifier: GPL-3.0-or-later
// The user's preferences that the preferences panel edits: how big one message may be, how many commands one reply may carry, and which
// folders are left out of the files that can be attached. All are kept in the extension's storage, the same on every site; the message
// size and the command count are read by message-budget.js from the same keys.

import { DEFAULT_BATCH_CALLS, DEFAULT_EXCLUDED_FOLDERS, clampBatchCalls, clampExcludedFolders, clampPromptChars } from "../domain/index.js";
import { clampContextFiles, DEFAULT_CONTEXT_FILES } from "../domain/prompt/context-file.js";

export const KEYS = { chars: "zsMaxPromptChars", calls: "zsMaxBatchCalls", folders: "zsExcludedFolders", contextFiles: "zsContextFiles", asFile: "zsOutputAsFile" };

/** @param {{ storage: object, state: object }} deps  `state.filesChangedAt` is bumped when the excluded folders change: the file list is then out of date */
export function createPreferences({ storage, state }) {
  let folders = [...DEFAULT_EXCLUDED_FOLDERS];
  const load = (saved) => { folders = clampExcludedFolders(saved); };
  storage.get(KEYS.folders).then(load);
  storage.watch(KEYS.folders, (saved) => { load(saved); state.filesChangedAt = Date.now(); });

  let contextFiles = [...DEFAULT_CONTEXT_FILES];
  const loadContext = (saved) => { contextFiles = clampContextFiles(saved); };
  storage.get(KEYS.contextFiles).then(loadContext);
  storage.watch(KEYS.contextFiles, loadContext);

  let asFile = false;
  storage.get(KEYS.asFile).then((saved) => { asFile = saved === true; });
  storage.watch(KEYS.asFile, (saved) => { asFile = saved === true; });

  return {
    /** Whether a message over the size goes to the chat as a file (the general value; an AI's calibration may set its own). */
    asFile: () => asFile,
    setAsFile(value) { asFile = value === true; storage.set(KEYS.asFile, asFile); },
    /** The folder names to leave out of the attachable files, as saved (the defaults until the user changes them). */
    excludedFolders: () => folders,
    /** What the panel shows. */
    async read() {
      const [chars, calls, saved, savedContext, savedAsFile] = await Promise.all([storage.get(KEYS.chars), storage.get(KEYS.calls), storage.get(KEYS.folders), storage.get(KEYS.contextFiles), storage.get(KEYS.asFile)]);
      return { chars: clampPromptChars(chars), calls: clampBatchCalls(calls ?? DEFAULT_BATCH_CALLS), asFile: savedAsFile === true, folders: clampExcludedFolders(saved), contextFiles: clampContextFiles(savedContext) };
    },
    setChars: (value) => storage.set(KEYS.chars, clampPromptChars(value)),
    setCalls: (value) => storage.set(KEYS.calls, clampBatchCalls(value)),
    setFolders(list) {
      folders = clampExcludedFolders(list);
      state.filesChangedAt = Date.now();
      storage.set(KEYS.folders, folders);
    },
    setContextFiles(list) {
      contextFiles = clampContextFiles(list);
      storage.set(KEYS.contextFiles, contextFiles);
    },
    contextFiles: () => contextFiles,
    defaultFolders: () => [...DEFAULT_EXCLUDED_FOLDERS],
    defaultContextFiles: () => [...DEFAULT_CONTEXT_FILES],
  };
}
