// SPDX-License-Identifier: GPL-3.0-or-later
// The only provider for now: it knows no chat site. It implements the provider contract with nothing found, so the
// extension boots, shows its bar, talks to the bridge and offers the "switch AI" shortcuts, and Start says why it
// cannot run yet. Replaced by the calibrated engine (docs/CALIBRATION.md); the old per-site adapters are in the
// git tag `pre-calibration`.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  let diag = () => {};
  const site = ZSSites.siteFor(location.hostname);
  const timings = {
    GEN_IDLE_MS: 2000, REASON_IDLE_MS: 15000, WARMUP_MS: 60000, REASON_NOREPLY_MS: 120000, STABLE_MS: 10000, RESPONSE_TIMEOUT_MS: 300000,
  };
  const none = () => null;
  const no = () => false;
  const empty = () => "";
  const notCalibrated = () => { throw new Error("This site is not calibrated yet."); };

  return {
    id: "uncalibrated",
    displayName: site ? site.name : location.hostname,
    timings,
    supportsVision: false,
    sendRetryLimit: 1,
    reliableCounts: true,
    chipAtItemLevel: true,
    init({ diag: d } = {}) { if (d) diag = d; }, // not logged here: main.js calls this before its own state exists
    // The bar shows this and keeps Start disabled (the same path sites with an unsupported chat mode used).
    modeWarning: () => "Not calibrated for this site yet",

    // turns
    allItems: () => [], isUserItem: no, isAssistantItem: no, itemText: empty, classifyText: empty,
    assistantCount: () => 0, userCount: () => 0, lastAssistant: none, lastAssistantId: none, itemKey: none,
    readAssistant: () => ({ present: false, reply: "", thinking: "", item: null }),
    chatIsEmpty: () => true, isFreshChat: no, conversationKey: () => location.pathname,
    // generation
    isGenerating: no, isHardGenerating: no, isBusyNow: no, streamLen: () => 0, snapshot: () => ({ th: 0, rp: 0 }),
    turnHalted: no, stopGeneration() {},
    // composer
    getEditor: none, editorText: empty, composerFrame: none, barAnchor: none,
    setInputLock() {}, installSendHooks() {}, enforceComposer: () => ({ ready: false }),
    ensureComposerReady: async () => ({ ready: false }),
    typeAndSend: async () => notCalibrated(),
    attachImages: no, clearAttachments() {},
    // chips and errors
    findToolBlockSpot: none, scanError: none, isTooLongMsg: no, isBusyMsg: no, findContinueBtn: none, clickContinueBtn: no,
  };
})();
