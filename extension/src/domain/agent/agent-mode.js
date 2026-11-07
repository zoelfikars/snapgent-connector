// SPDX-License-Identifier: GPL-3.0-or-later
// The agent's on/off switch ("Discussion" mode) and the one slot that is Stop while the agent is busy and Play when it is idle.
// Pure: facts in, what to show or do out.

import { hasToolSignature } from "../parser/index.js";

/**
 * Which face the Stop / Play slot wears. Stop belongs to the busy agent (the bar shows it itself, so "stop" is only reported here);
 * Play only to an idle, live session whose agent is on.
 * @returns {"stop"|"play"|"off"}
 */
export function controlFace({ discuss, busy, started, starting, stale }) {
  if (stale || starting || !started) return "off";
  if (busy) return "stop";
  return discuss ? "off" : "play";
}

/**
 * What Play does with the latest reply. A reply that already ran is never run again: that would repeat its side effects.
 * @returns {{ type: "generating"|"none"|"already-ran"|"run" }}
 */
export function planReplay({ text, generating, alreadyRan }) {
  if (generating) return { type: "generating" };
  if (!hasToolSignature(text || "")) return { type: "none" };
  return { type: alreadyRan ? "already-ran" : "run" };
}
