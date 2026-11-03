// SPDX-License-Identifier: GPL-3.0-or-later
// The calibrations that ship with the extension (profiles/default-calibrations.json, written by "Export all calibrations"): what a site
// is read with until the user calibrates it themselves. Pure: it only looks into the file's data.

/**
 * @param {*} bundle  the parsed default-calibrations file
 * @param {string} host
 * @returns {object|null} the profile shipped for `host`, or null
 */
export function defaultProfile(bundle, host) {
  if (!bundle || bundle.format !== "snapgent-calibrations" || !bundle.sites || typeof bundle.sites !== "object") return null;
  for (const site of Object.values(bundle.sites)) {
    const profile = site && site.profiles && site.profiles[host];
    if (profile) return profile;
  }
  return null;
}
