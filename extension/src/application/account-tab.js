// SPDX-License-Identifier: GPL-3.0-or-later
// Which tab shows the site whose accounts are being switched: the active tab of one of the site's own URLs. Pure, and the only
// place that turns the registry entry into tab matching, so the popup cannot pass an id where an entry is wanted.

/**
 * @param {{ matches: string[] }} site the registry entry (it has `matches`, not just an id)
 * @param {Array<{ active?: boolean, url?: string, id?: number }>} tabs what the browser reports
 * @returns {object|null} the tab, or null when the site is not open
 */
export function matchingTab(site, tabs) {
  if (!site || !Array.isArray(site.matches) || !Array.isArray(tabs)) return null;
  const hosts = site.matches.map((pattern) => new URL(pattern.replace("*", "x")).hostname);
  return tabs.find((tab) => tab.active && tab.url && hosts.some((host) => tab.url.includes(host))) || null;
}
