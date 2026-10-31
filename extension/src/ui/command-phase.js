// SPDX-License-Identifier: GPL-3.0-or-later
// What a model turn that contains a tool call should show: running, done, stopped, failed, or "not run".
// Pure decisions from plain facts about the turn and the session, so every situation can be tested
// without a page. The page gathers the facts (it owns the DOM and the loop state) and paints the result.

export const REGEN_HOLD_MS = 6000;
export const RESUME_GRACE_MS = 2500;
const REGEN_REPLACED_SLACK = 8;

/**
 * After a post-stop regenerate the site still shows the OLD command until it wipes and re-streams.
 * While that is the case keep the red "stopped" look, not a fresh spinner on the stale call.
 * @returns {boolean} true = keep holding
 */
export function holdsRegenerateLook({ baseLength, armedAt, textLength, now }) {
  const replaced = textLength < baseLength - REGEN_REPLACED_SLACK; // old content wiped
  const expired = now - armedAt > REGEN_HOLD_MS;                  // safety fallback
  return !replaced && !expired;
}

/**
 * Is this turn the halted one? A turn that is generating again, or whose tool is running, with no live
 * stop latch, was regenerated and is no longer halted; otherwise any one of the three records says so.
 * `regenerating` is returned so the caller can clear the stale halt it implies.
 */
export function haltState({ userStopped, isLast, generating, toolRunningOnThisTurn, marked, remembered }) {
  const regenerating = !userStopped && ((isLast && generating) || toolRunningOnThisTurn);
  const stopped = !regenerating && (marked || (userStopped && isLast) || remembered);
  return { regenerating, stopped };
}

/**
 * The loop already settled this very call, but the site swapped the node and wiped the chip and the
 * loop's ownership. Re-own it with the settled outcome instead of re-deriving a spinner.
 */
export function shouldReown({ stopped, running, toolRunning, hasSettled, sameTurn, isLast, sameTool }) {
  return !stopped && running && !toolRunning && hasSettled && sameTurn && isLast && sameTool;
}

/**
 * @param {object} f
 * @param {boolean} f.stopped        the user halted this turn
 * @param {boolean} f.isLast         it is the last assistant turn
 * @param {boolean} f.generating     the site is generating right now
 * @param {boolean} f.running        the loop is running
 * @param {boolean} f.starting       a session is bootstrapping
 * @param {boolean} f.resultBelow    the injected result of this call is the next turn
 * @param {boolean} f.executedBefore the off-DOM memory says this call already ran
 * @param {boolean} f.resumeArmed    regenerate grace is armed
 * @param {number}  f.resumeArmedAt
 * @param {number}  f.lastGenAt      when generation last showed activity
 * @param {number}  f.freshMs        how long the resume watchdog may still run a finished command
 * @param {number}  f.now
 * @param {boolean} f.dsml           the model called a tool in its own markup (can never run)
 * @param {boolean} f.errorBelow     the result right below is an error
 * @returns {{ phase: "run"|"done"|"err"|"idle", detail: string, live: boolean, inFlight: boolean, resumeGrace: boolean, pendingExec: boolean, errorSettled: boolean }}
 */
export function commandPhase(f) {
  const inFlight = (f.running || f.starting) && !f.resultBelow;
  // Keeps the fresh command "run" between regenResume clearing the stop latch and the watchdog starting the loop.
  const resumeGrace = f.resumeArmed && f.isLast && f.now - (f.resumeArmedAt || 0) < RESUME_GRACE_MS;
  const live = !f.stopped && (inFlight || resumeGrace || (f.isLast && f.generating));
  // A call with no evidence it ever ran: no result below, and not in the executed memory.
  const neverRun = !f.resultBelow && !f.executedBefore;
  // Abandoned: a newer assistant turn exists, so it will never run (neither a green tick nor a live spinner).
  const supersededOrphan = neverRun && !f.isLast;
  // Reload orphan: the last command whose generation is stale; the watchdog refuses to run it, so no false tick.
  const staleLastOrphan = neverRun && f.isLast && !live && f.now - f.lastGenAt > f.freshMs;
  const orphanPending = !f.stopped && (supersededOrphan || staleLastOrphan);
  // Just finished, loop not started yet: keep spinning rather than flash a premature tick (same window as the watchdog).
  const pendingExec = !f.stopped && !orphanPending && !live && neverRun && f.isLast && f.now - f.lastGenAt <= f.freshMs;

  let phase = f.stopped ? "err" : orphanPending ? "idle" : (live || pendingExec) ? "run" : "done";
  let detail = f.stopped ? "stopped" : orphanPending ? "not run" : "";
  // A finished DSML turn is already decided (it can never run), so neither spinner nor "not run" fits.
  if (!f.stopped && !live && phase !== "err" && f.dsml) { phase = "err"; detail = "wrong format"; }
  // A call whose result right below is an error never wears a green tick, even after the loop lost ownership.
  let errorSettled = false;
  if (phase === "done" && f.errorBelow) { phase = "err"; detail = "error"; errorSettled = true; }
  return { phase, detail, live, inFlight, resumeGrace, pendingExec, errorSettled };
}
