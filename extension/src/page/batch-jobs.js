// SPDX-License-Identifier: GPL-3.0-or-later
// The id of the batch being run for a reply, kept across a page reload. The reply is run again after a reload, and under the same
// id the VS Code server answers the commands that already ran instead of running them twice (see BatchRunner). The id is dropped
// when the batch is answered or stopped, so running the same reply later is a new batch.

const KEY = "zsBatches";
const LIFETIME_MS = 15 * 60 * 1000;
const KEPT = 50;

/** @param {{ storage: object, provider: object, turnKey: (item: object) => string }} deps */
export function createBatchJobs({ storage, provider, turnKey }) {
  const keyOf = (item) => `${provider.conversationKey() || "new"}|${turnKey(item)}`;
  const read = async () => (await storage.get(KEY)) || {};
  return {
    async begin(item) {
      const now = Date.now();
      const live = Object.fromEntries(Object.entries(await read()).filter(([, batch]) => now - batch.at < LIFETIME_MS));
      const key = keyOf(item);
      if (!live[key]) live[key] = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: now };
      storage.set(KEY, Object.fromEntries(Object.entries(live).slice(-KEPT)));
      return live[key].id;
    },
    async end(item) {
      const all = await read();
      delete all[keyOf(item)];
      storage.set(KEY, all);
    },
  };
}
