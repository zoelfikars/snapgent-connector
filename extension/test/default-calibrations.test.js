import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultProfile, learnProfile } from "../src/infrastructure/calibration/index.js";
import { createProvider } from "../src/page/provider.js";
import { pageWith } from "./support/jsdom-provider.js";

const PAGE = `<html><body>
  <div class="turn-user">hello</div>
  <div class="turn-assistant"><pre>{"command":"read_file","params":{"path":"a.js"}}</pre></div>
  <form><div id="box" contenteditable="true" role="textbox"></div><button aria-label="Send prompt"></button></form>
</body></html>`;
const URL = "https://chatgpt.com/c/test";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function learned() {
  const { document } = pageWith(PAGE, URL);
  const result = learnProfile({
    hostname: "chatgpt.com", name: "ChatGPT",
    picks: { composer: document.getElementById("box"), send: document.querySelector("button"), assistant: document.querySelector("pre"), user: document.querySelector(".turn-user") },
  });
  assert.equal(result.error, undefined);
  return JSON.parse(JSON.stringify(result.profile));
}
const bundleOf = (profile) => ({ format: "snapgent-calibrations", version: 1, sites: { chatgpt: { name: "ChatGPT", profiles: { [profile.site]: profile } } } });

describe("defaultProfile", () => {
  test("finds the profile shipped for a host, whichever AI it is listed under", () => {
    const profile = learned();
    assert.equal(defaultProfile(bundleOf(profile), "chatgpt.com"), profile);
    assert.equal(defaultProfile(bundleOf(profile), "claude.ai"), null);
  });

  test("an empty, missing or foreign file ships nothing", () => {
    for (const bundle of [null, undefined, {}, { format: "other", sites: {} }, { format: "snapgent-calibrations", sites: null }, { format: "snapgent-calibrations", sites: { x: null } }]) {
      assert.equal(defaultProfile(bundle, "chatgpt.com"), null);
    }
  });
});

describe("the provider and the shipped calibrations", () => {
  async function start({ stored, defaults }) {
    const { document, window } = pageWith(PAGE, URL);
    const storage = { get: async () => stored, watch() {} };
    const provider = createProvider({ document, location: window.location, storage, diag() {}, defaults });
    await flush();
    return provider;
  }

  test("a site the user has not calibrated is read with the shipped calibration", async () => {
    const provider = await start({ stored: undefined, defaults: bundleOf(learned()) });
    assert.equal(provider.calibrationSource, "default");
    assert.equal(provider.id, "chatgpt-com");
    assert.equal(provider.needsCalibration, false);
  });

  test("the user's own calibration wins over the shipped one", async () => {
    const own = learned();
    const provider = await start({ stored: { "chatgpt.com": own }, defaults: bundleOf(learned()) });
    assert.equal(provider.calibrationSource, "own");
  });

  test("an own profile that is not usable falls back to the shipped one", async () => {
    const provider = await start({ stored: { "chatgpt.com": { version: 99 } }, defaults: bundleOf(learned()) });
    assert.equal(provider.calibrationSource, "default");
  });

  test("with neither, the site is not calibrated", async () => {
    const provider = await start({ stored: undefined, defaults: bundleOf({ ...learned(), site: "claude.ai" }) });
    assert.equal(provider.calibrationSource, "none");
    assert.equal(provider.id, "uncalibrated");
  });
});
