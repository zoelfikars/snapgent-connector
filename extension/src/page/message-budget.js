// SPDX-License-Identifier: GPL-3.0-or-later
// How big ONE message into the chat may be, and how many commands one reply may carry (`zsMaxBatchCalls`). The toolbar popup's slider (`zsMaxPromptChars`) sets it; a site that once refused a
// message as too long can only lower it (until the slider moves); the loop splits it between the results of one reply. Also
// counts what a conversation has sent so far, because the history counts against the context too.

import { MIN_PROMPT_CHARS, clampBatchCalls, clampPromptChars, effectiveLimit } from "../domain/index.js";

const SETTING_KEY = "zsMaxPromptChars";
const CALLS_KEY = "zsMaxBatchCalls";
const VOLUMES_KEY = "zsVolumes";
const VOLUMES_KEPT = 200;
const LEARNED_SHARE = 0.6; // after a "too long": stay at this share of the size that was refused

/** @param {{ storage: object, hostname: string, provider: object, diag: Function }} deps */
export function createMessageBudget({ storage, hostname, provider, diag }) {
  const learnedKey = `zsLearnedCap:${hostname}`;
  let setting = clampPromptChars(undefined);
  let calls = clampBatchCalls(undefined);
  let learned = Infinity;
  const volume = { key: "", total: 0 };

  storage.get(SETTING_KEY).then((saved) => { setting = clampPromptChars(saved); });
  storage.get(learnedKey).then((saved) => { if (saved > 0) learned = saved; });
  storage.get(CALLS_KEY).then((saved) => { calls = clampBatchCalls(saved); });
  storage.watch(CALLS_KEY, (saved) => { calls = clampBatchCalls(saved); });
  storage.watch(SETTING_KEY, (saved) => { setting = clampPromptChars(saved); learned = Infinity; storage.remove(learnedKey); });

  // This AI's own values (from its calibration) win over the general preferences; read on every use, the provider changes without a reload.
  const siteLimits = () => provider.limits || {};
  const limit = () => effectiveLimit(siteLimits().chars > 0 ? siteLimits().chars : setting, Math.min(provider.sendCharBudget || Infinity, learned));

  async function sent(chars) {
    const key = provider.conversationKey() || "new";
    if (volume.key !== key) {
      volume.key = key;
      volume.total = 0;
      storage.get(VOLUMES_KEY).then((all) => { const saved = all && all[key]; if (volume.key === key && saved > 0) volume.total += saved; });
    }
    volume.total += chars;
    const all = { ...((await storage.get(VOLUMES_KEY)) || {}) };
    delete all[key];
    all[key] = volume.total;
    storage.set(VOLUMES_KEY, Object.fromEntries(Object.keys(all).slice(-VOLUMES_KEPT).map((k) => [k, all[k]])));
    return volume.total;
  }

  function tooLong(chars) {
    if (!(chars > 0)) return;
    learned = Math.max(MIN_PROMPT_CHARS, Math.floor(chars * LEARNED_SHARE));
    storage.set(learnedKey, learned);
    diag("budget.learned", { chars, cap: learned });
  }

  return { limit, calls: () => (siteLimits().calls > 0 ? clampBatchCalls(siteLimits().calls) : calls), sent, tooLong };
}
