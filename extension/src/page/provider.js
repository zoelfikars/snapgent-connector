// SPDX-License-Identifier: GPL-3.0-or-later
// The chat site as the rest of the page code sees it (docs/CALIBRATION.md). Until a profile for this host is stored it is the
// "uncalibrated" provider: the same contract with nothing found, so the extension still boots, shows its bar and says why Start
// cannot run. When a profile is stored (`zsProfiles`, written by the calibration UI) every call goes to the engine built from it.

import { createCalibratedProvider, defaultProfile, profileProblems } from "../infrastructure/calibration/index.js";
import { siteFor } from "../sites/registry.js";

const TIMINGS = {
  GEN_IDLE_MS: 2000, REASON_IDLE_MS: 15000, WARMUP_MS: 60000, REASON_NOREPLY_MS: 120000, STABLE_MS: 10000, RESPONSE_TIMEOUT_MS: 300000,
};
const none = () => null;
const no = () => false;
const empty = () => "";

function uncalibrated(location) {
  const site = siteFor(location.hostname);
  return {
    id: "uncalibrated",
    displayName: site ? site.name : location.hostname,
    timings: TIMINGS,
    supportsVision: false,
    sendRetryLimit: 1,
    reliableCounts: true,
    modeWarning: () => "Not calibrated for this site yet",
    needsCalibration: true,
    health: () => ({ ok: false, problems: [{ role: "all", reason: "not calibrated" }] }),

    allItems: () => [], isUserItem: no, isAssistantItem: no, itemText: empty,
    assistantCount: () => 0, userCount: () => 0, lastAssistant: none, lastAssistantId: none, itemKey: none,
    readAssistant: () => ({ present: false, reply: "", thinking: "", item: null }),
    chatIsEmpty: () => true, isFreshChat: no, conversationKey: () => "",

    isGenerating: no, isHardGenerating: no, isBusyNow: no, streamLen: () => 0, snapshot: () => ({ th: 0, rp: 0 }),
    turnHalted: no, stopGeneration() {},

    getEditor: none, editorText: empty, composerFrame: none, setInputLock() {}, installSendHooks() {},
    enforceComposer: () => ({ ready: false }), ensureComposerReady: async () => ({ ready: false }),
    typeAndSend: async () => { throw new Error("This site is not calibrated yet."); },
    writeText: async () => { throw new Error("This site is not calibrated yet."); },

    scanError: none, isTooLongMsg: no, findContinueBtn: none, clickContinueBtn: no,
  };
}

/**
 * The provider for this page. Callers read members on every use, so the answer changes underneath them when a profile is
 * stored or removed; `zs-provider-changed` is dispatched then so the bar redraws.
 *   `defaults` is the parsed default-calibrations file: a site the user has not calibrated (or whose own profile is unusable) is read with it.
 * @param {{ document: Document, location: Location, storage: object, diag: (event: string, data?: object) => void, defaults?: object }} deps
 */
export function createProvider({ document, location, storage, diag, defaults = null }) {
  const idle = uncalibrated(location);
  let current = idle;
  let source = "none"; // whose calibration is in use: the user's own, the one shipped with the extension, or none

  function adopt(own) {
    const shipped = defaultProfile(defaults, location.hostname);
    source = "none";
    current = idle;
    for (const [from, profile] of [["own", own], ["default", shipped]]) {
      if (!profile) continue;
      const problems = profileProblems(profile);
      if (problems.length) { diag("profile.invalid", { from, problems }); continue; }
      current = createCalibratedProvider({ document, location, profile, diag });
      source = from;
      break;
    }
    document.dispatchEvent(new document.defaultView.Event("zs-provider-changed"));
  }
  const forThisHost = (all) => (all && all[location.hostname]) || null;
  storage.get("zsProfiles").then((all) => adopt(forThisHost(all)));
  storage.watch("zsProfiles", (all) => adopt(forThisHost(all)));

  return new Proxy({}, {
    get: (_target, key) => (key === "calibrationSource" ? source : key in current ? current[key] : idle[key]),
    has: (_target, key) => key === "calibrationSource" || key in current || key in idle,
  });
}
