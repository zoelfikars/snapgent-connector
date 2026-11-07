// SPDX-License-Identifier: GPL-3.0-or-later
// Re-stating the system prompt in a long conversation. Some sites summarise their own context mid-conversation and the model then
// forgets that an extension runs its commands. A provider that needs this sets `resendSystemEvery`; the prompt then rides on the
// next result, and if nothing carries it for a while it is sent as a turn of its own (one message from the site's quota, so a
// fallback). The fallback never fires mid-generation, while the loop or a start owns the composer, or over the user's own draft.

import { PromptResender, SysTally } from "../application/index.js";
import { countSinceLastMarker } from "../domain/prompt/resend.js";

const FALLBACK_IDLE_MS = 20000;
const FALLBACK_CHECK_MS = 5000;

/** @param {{ provider: object, state: object, storage: object, systemPrompt: () => string, limit: () => number, chat: object, diag: Function }} deps */
export function createPromptResend({ provider, state, storage, systemPrompt, limit, chat, diag }) {
  const tally = new SysTally({ storage, conversationKey: () => provider.conversationKey(), enabled: !!provider.resendSystemEvery });
  const resender = new PromptResender({
    tally,
    everyUsers: provider.resendSystemEvery || 0,
    systemPrompt,
    // What is on screen is a floor under the stored tally (a session adopted from another device, cleared storage).
    domCounts: () => {
      const items = provider.allItems();
      return countSinceLastMarker(items.length, (i) => ({ text: provider.itemText(items[i]), isUser: provider.isUserItem(items[i]) }));
    },
    charBudget: limit,
    diag,
  });

  setInterval(async () => {
    if (!resender.due() || !state.started || state.running || state.starting || state.injecting || state.discuss) return;
    if (document.hidden || state.userStopped || provider.isGenerating()) return;
    try { if ((provider.editorText() || "").trim() !== "") return; } catch { return; }
    if (Date.now() - state.lastGenAt < FALLBACK_IDLE_MS) return; // give the free path (riding on a result) a fair chance first
    resender.claim("ownTurn");
    try {
      await chat.waitForResponse(await chat.submit(systemPrompt()));
    } catch (error) {
      diag("sys.resendFailed", { err: String((error && error.message) || error) });
    }
  }, FALLBACK_CHECK_MS);

  return {
    hydrate: () => tally.hydrate(),
    bump: (field) => resender.bump(field),
    attach: (text) => resender.attach(text),
    reserve: () => resender.reserve(),
  };
}
