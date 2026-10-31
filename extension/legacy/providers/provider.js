// SPDX-License-Identifier: GPL-3.0-or-later
// The one provider script for every site (docs/CALIBRATION.md). Until a profile for this site exists it is the
// "uncalibrated" provider: it implements the provider contract with nothing found, so the extension boots, shows its bar,
// talks to the bridge and offers the "switch AI" shortcuts, and Start says why it cannot run yet. When a profile is stored
// for this host (`zsProfiles` in extension storage, written by the calibration UI) every call goes to the calibrated engine
// built from it instead. The old per-site adapters are in the git tag `pre-calibration`.
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

  const uncalibrated = {
    id: "uncalibrated",
    displayName: site ? site.name : location.hostname,
    timings,
    supportsVision: false,
    sendRetryLimit: 1,
    reliableCounts: true,
    chipAtItemLevel: true,
    init() {},
    // The bar shows this and keeps Start disabled (the same path sites with an unsupported chat mode used).
    modeWarning: () => "Not calibrated for this site yet",
    needsCalibration: true,
    health: () => ({ ok: false, problems: [{ role: "all", reason: "not calibrated" }] }),

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

  // ── which of the two answers ──────────────────────────────────────────────
  let current = uncalibrated;
  function adopt(profile) {
    const problems = profile ? ZSCalibration.profileProblems(profile) : [];
    if (problems.length) diag("profile.invalid", { problems });
    current = profile && !problems.length
      ? ZSCalibration.createCalibratedProvider({ document, location, profile, diag: (event, data) => diag(event, data) })
      : uncalibrated;
    document.dispatchEvent(new Event("zs-provider-changed")); // the page script redraws the bar and re-reads the page
  }
  const profileFrom = (all) => (all && all[location.hostname]) || null;
  try {
    chrome.storage.local.get("zsProfiles", (r) => adopt(profileFrom(r && r.zsProfiles)));
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.zsProfiles) adopt(profileFrom(changes.zsProfiles.newValue)); });
  } catch { /* no extension storage here: stay uncalibrated */ }

  // Callers read members on every use, so the answer can change underneath them when a profile is stored or removed.
  const own = { init(options = {}) { if (options.diag) diag = options.diag; } };
  return new Proxy({}, {
    get: (_target, key) => (key in own ? own[key] : key in current ? current[key] : uncalibrated[key]),
    has: (_target, key) => key in own || key in current || key in uncalibrated,
  });
})();
