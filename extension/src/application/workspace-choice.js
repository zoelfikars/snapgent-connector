// SPDX-License-Identifier: GPL-3.0-or-later
// Which folder a new chat will work in. The folder the user pinned is the default; otherwise the only open folder; and when VS Code has
// several open the user is asked (its "active window" is not reliable enough to guess). Orchestration of one decision, no page code.

/**
 * @param {{ ok?: boolean, error?: string, open?: string[], pinned?: string|null }} listing  what the bridge says about VS Code's folders
 * @param {(open: string[]) => Promise<string|null>} ask  lets the user pick one (null: closed without choosing)
 * @returns {Promise<{ path?: string, none?: boolean, cancelled?: boolean, error?: string }>}
 */
export async function chooseWorkspace(listing, ask) {
  if (!listing || !listing.ok) return { error: (listing && listing.error) || "The bridge is not reachable." };
  const open = listing.open || [];
  if (listing.pinned) return { path: listing.pinned };
  if (open.length === 1) return { path: open[0] };
  if (open.length === 0) return { none: true };
  const picked = await ask(open);
  return picked ? { path: picked } : { cancelled: true };
}
