// SPDX-License-Identifier: GPL-3.0-or-later
// The name of one command inside a batch, so the server can tell "the same command again" (the page was reloaded while
// the batch ran) from a new one. Batch id (random, kept only while the batch lasts) + place in the batch + a hash of the
// command: another reply, or the same reply run later under a new batch id, never matches. Pure.

/** FNV-1a, 32 bits: only needs to tell two commands of one batch apart, not to be secret. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** @param {string} batchId @param {number} index @param {{ tool: string, arguments?: object }} call */
export function jobKey(batchId, index, call) {
  let body = "";
  try { body = JSON.stringify(call.arguments || {}); } catch { /* unserialisable: the name and place still tell it apart */ }
  return `${batchId}:${index}:${hash(`${call.tool}\n${body}`)}`;
}
