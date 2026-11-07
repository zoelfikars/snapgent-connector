// SPDX-License-Identifier: GPL-3.0-or-later
// Telling assistant turns apart. Sites recycle turn nodes (a long chat is virtualised), so a mark on a node does not survive:
// turns are identified by the site's own id when it has one, else by position, and "this turn's command already ran" is
// remembered off the page in a TurnMemory.

import { BatchProgress, TurnMemory } from "../application/index.js";

export function createTurns({ provider }) {
  const position = (item) => provider.allItems().filter(provider.isAssistantItem).indexOf(item);
  const turnKey = (item) => {
    const id = provider.itemKey && provider.itemKey(item);
    return id != null ? `k${id}` : String(position(item));
  };
  const executed = new TurnMemory({
    conversationKey: () => provider.conversationKey(),
    keyOf: turnKey,
    isRendered: (item) => position(item) >= 0,
    textOf: (item) => provider.itemText(item),
  });
  // What a batch that Stop ended already did, so Play can carry on from there.
  const progress = new BatchProgress({ conversationKey: () => provider.conversationKey(), keyOf: turnKey });
  return { turnKey, executed, progress };
}
