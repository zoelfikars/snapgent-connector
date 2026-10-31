// SPDX-License-Identifier: GPL-3.0-or-later
// Pure manifest generation: base.json + the site registry + per-browser deltas.
import { SITES, allMatches } from "../src/sites/registry.js";

export const TARGETS = ["chrome", "firefox"];
const GECKO_ID = "snapgent@herdodp.github.io";
const FIREFOX_MIN_VERSION = "128.0"; // first release with MV3 `world: "MAIN"` content scripts

const CORE_SCRIPTS = ["globals.js", "main.js"];

// One provider script for every site: it is calibrated from a stored profile or says "not calibrated" (docs/CALIBRATION.md).
export function contentScripts(sites = SITES) {
  return sites.map((site) => ({
    matches: site.matches,
    js: ["globals.js", "providers/provider.js", "main.js"],
    css: ["overlay.css"],
    run_at: "document_idle",
  }));
}

export function hostPermissions(sites = SITES) {
  const extra = sites.flatMap((site) => site.extraHosts || []);
  return [...new Set([...allMatches(), ...extra]), "http://127.0.0.1/*", "ws://127.0.0.1/*"];
}

export function buildManifest(base, { target, version }) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown target "${target}"`);
  const manifest = {
    ...base,
    version,
    host_permissions: hostPermissions(),
    content_scripts: contentScripts(),
  };
  if (target === "firefox") {
    // Firefox MV3 has no service workers; it runs the background as an event page.
    manifest.background = { scripts: ["background.js"] };
    manifest.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION } };
  } else {
    manifest.background = { service_worker: "background.js" };
  }
  return manifest;
}

export { CORE_SCRIPTS };
