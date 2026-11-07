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
 * A batch that Stop ended part-way (`pending` commands finished) is carried on instead: only the rest runs.
 * @returns {{ type: "generating"|"none"|"already-ran"|"run" } | { type: "resume", done: number }}
 */
export function planReplay({ text, generating, alreadyRan, pending = 0 }) {
  if (generating) return { type: "generating" };
  if (!hasToolSignature(text || "")) return { type: "none" };
  if (pending > 0) return { type: "resume", done: pending };
  return { type: alreadyRan ? "already-ran" : "run" };
}
