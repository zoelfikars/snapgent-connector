// SPDX-License-Identifier: GPL-3.0-or-later
// The conversation as the agent uses it: wait for the model's reply, send a message into the composer.

import { MessageSender, ResponseWatcher } from "../application/index.js";
import { describeAnchor } from "../infrastructure/chat/index.js";
import { SESSION_PHRASE } from "../domain/constants.js";
import { createOutputFile } from "./output-file.js";
import { sleep, waitFor } from "./visibility.js";

// What the cover says while the extension waits for the AI, in the order the waiting really goes.
const PHASE_LABELS = {
  waiting: "Waiting for the AI to start its reply…",
  writing: "The AI is writing its reply…",
  checking: "Reply looks finished · checking that it is complete…",
  reading: "Reading the commands in the reply…",
};

/**
 * @param {{ document: Document, provider: object, state: object, visibility: object, catalogue: object, diag: Function,
 *           cover: (on: boolean) => void, banner: Function }} deps
 */
export function createChat({ document, provider, state, visibility, catalogue, diag, cover, banner, progress = () => {}, budget = null }) {
  const outputFile = createOutputFile({ provider, budget, diag });
  // Optional provider abilities are handed over only when the provider has them.
  const optional = (name) => (typeof provider[name] === "function" ? (...args) => provider[name](...args) : undefined);

  // What the page looks like, for the log when the engine cannot find what it expects: the element chains around text we KNOW
  // is there (our own words, the model's command) are what is needed to teach a new page layout.
  const describeLayout = () => ({
    provider: provider.id,
    users: provider.userCount(),
    assistants: provider.assistantCount(),
    markerChain: describeAnchor(document, SESSION_PHRASE),
    replyChain: describeAnchor(document, '"command"'),
  });

  const watcher = new ResponseWatcher({
    chat: {
      isGenerating: () => provider.isGenerating(),
      readAssistant: () => provider.readAssistant(),
      lastAssistantId: optional("lastAssistantId"),
      assistantCount: () => provider.assistantCount(),
      scanError: () => provider.scanError(),
      turnHalted: (item) => provider.turnHalted(item),
      isTooLongMsg: (text) => provider.isTooLongMsg(text),
      findContinueBtn: () => provider.findContinueBtn(),
      reliableCounts: provider.reliableCounts,
      replyUnsettled: optional("replyUnsettled"),
    },
    visibility: { isHidden: visibility.isHidden, parkHidden: visibility.parkHidden },
    isStopped: () => state.stop,
    sendToken: () => state.sendToken,
    clock: { now: () => Date.now(), sleep },
    timings: provider.timings,
    knowsTool: (name) => catalogue.knows(name),
    catalogueSize: () => catalogue.names().size,
    describeLayout,
    diag,
    phase: (name) => progress(PHASE_LABELS[name]),
  });

  const sender = new MessageSender({
    page: {
      lastAssistant: () => provider.lastAssistant(),
      streamLen: (item) => provider.streamLen(item),
      isGenerating: () => provider.isGenerating(),
      isBusyNow: () => provider.isBusyNow(),
      assistantCount: () => provider.assistantCount(),
      userCount: () => provider.userCount(),
      editorText: () => provider.editorText(),
      typeAndSend: (text) => provider.typeAndSend(text),
    },
    visibility,
    effects: {
      // The reply to what we send is read by identity of the last turn, not by count: virtualised lists keep the count flat.
      begin() { state.sendToken = provider.lastAssistantId ? provider.lastAssistantId() : undefined; state.injecting = true; cover(true); },
      end() {
        if (!state.starting && !state.running) cover(false);
        setTimeout(() => { state.injecting = false; }, 400);
      },
    },
    clock: { sleep, waitFor },
    isStopped: () => state.stop,
    retryLimit: provider.sendRetryLimit,
    notify: { banner },
    diag,
  });

  return {
    describeLayout,
    /** The loop's and the starter's view of the conversation. */
    turns: {
      next: (base) => watcher.wait(base),
      submit: async (text) => sender.submit(await outputFile.prepare(text)),
      isHalted: (item) => provider.turnHalted(item),
      resumeTruncated: async () => !!(provider.clickContinueBtn() && await waitFor(() => provider.isGenerating(), 2500)),
    },
    waitForResponse: (base) => watcher.wait(base),
    submit: async (text) => sender.submit(await outputFile.prepare(text)),
  };
}
