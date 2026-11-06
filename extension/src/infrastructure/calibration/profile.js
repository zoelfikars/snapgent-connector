// SPDX-License-Identifier: GPL-3.0-or-later
// A site profile: everything the extension knows about one chat site, as data. Built from what the user clicked.

import { learnBodySelector, learnSelector, learnThinkingSelector, learnTurnSelectors } from "./selector-learning.js";

export const PROFILE_VERSION = 1;

/**
 * @typedef {Object} Profile
 * @property {number} version
 * @property {string} site         host name the profile applies to
 * @property {string} name
 * @property {{ selector: string }} composer
 * @property {{ selector?: string, enter?: boolean }} send
 * @property {{ turn: string, body: string|null, thinking?: string }} assistant   `thinking`: the reasoning inside the same turn, left out of the reply
 * @property {{ turn: string }} user
 * @property {{ selector: string }|null} stop    optional; otherwise found by label next to the composer
 * @property {{ chars?: number, calls?: number }} [limits]   what this AI accepts: message size and commands per reply; absent = the general preferences
 * @property {{ selector: string }|null} [card]   optional: the box around the text box and its buttons; otherwise found by looking
 */

/**
 * Learn a profile from the elements the user clicked.
 * @param {{ hostname: string, name: string,
 *           picks: { composer: Element, send?: Element|null, assistant: Element, user: Element, assistantInner?: Element|null, card?: Element|null } }} input
 * @returns {{ profile: Profile, warnings: string[] } | { error: string }}
 */
export function learnProfile({ hostname, name, picks }) {
  const warnings = [];
  const composer = learnSelector(picks.composer, { onlyVisible: true, unique: true }) || learnSelector(picks.composer, { onlyVisible: true });
  if (!composer) return { error: "Could not describe the text box in a way that finds it again." };
  if (!learnSelector(picks.composer, { onlyVisible: true, unique: true })) warnings.push("The text box selector also matches other elements; the first visible one is used.");

  let send = { enter: true };
  if (picks.send) {
    const selector = learnSelector(picks.send, { onlyVisible: true, unique: true }) || learnSelector(picks.send, { onlyVisible: true });
    if (!selector) return { error: "Could not describe the send button in a way that finds it again." };
    send = { selector };
  }

  const turns = learnTurnSelectors(picks.assistant, picks.user, [picks.composer, picks.send].filter(Boolean));
  if (turns.error) return { error: turns.error };
  const body = learnBodySelector(turns.assistantTurn, picks.assistantInner || null);
  if (picks.assistantInner && !body) warnings.push("Could not describe the part of the reply you chose; the whole reply is read.");
  const thinking = learnThinkingSelector(turns.assistantTurn, picks.assistantThinking || null);
  if (picks.assistantThinking && !thinking) warnings.push("Could not describe the thinking part you chose; it is read as part of the reply.");

  let card = null;
  if (picks.card) {
    const selector = learnSelector(picks.card, { onlyVisible: true });
    if (selector) card = { selector }; else warnings.push("Could not describe the box you chose; it is found by looking instead.");
  }

  return {
    profile: {
      version: PROFILE_VERSION, site: hostname, name,
      composer: { selector: composer }, send,
      assistant: { turn: turns.assistant, body, ...(thinking ? { thinking } : {}) }, user: { turn: turns.user },
      stop: null, card,
    },
    warnings,
  };
}

/**
 * Re-learn one part of an existing profile from new clicks, leaving the rest as it is.
 * `role`: "composer" | "send" | "reply" | "card". "send" with no pick means "Enter sends". "reply" needs `assistant` and `user`.
 * @returns {{ profile: Profile, warnings: string[] } | { error: string }}
 */
export function updateProfile(profile, role, picks) {
  const warnings = [];
  if (role === "composer") {
    const selector = learnSelector(picks.composer, { onlyVisible: true, unique: true }) || learnSelector(picks.composer, { onlyVisible: true });
    if (!selector) return { error: "Could not describe the text box in a way that finds it again." };
    return { profile: { ...profile, composer: { selector } }, warnings };
  }
  if (role === "send") {
    if (!picks.send) return { profile: { ...profile, send: { enter: true } }, warnings };
    const selector = learnSelector(picks.send, { onlyVisible: true, unique: true }) || learnSelector(picks.send, { onlyVisible: true });
    if (!selector) return { error: "Could not describe the send button in a way that finds it again." };
    return { profile: { ...profile, send: { selector } }, warnings };
  }
  if (role === "reply") {
    const turns = learnTurnSelectors(picks.assistant, picks.user, picks.keepOut || []);
    if (turns.error) return { error: turns.error };
    const body = learnBodySelector(turns.assistantTurn, picks.assistantInner || null);
    if (picks.assistantInner && !body) warnings.push("Could not describe the part of the reply you chose; the whole reply is read.");
    const thinking = learnThinkingSelector(turns.assistantTurn, picks.assistantThinking || null);
    if (picks.assistantThinking && !thinking) warnings.push("Could not describe the thinking part you chose; it is read as part of the reply.");
    return { profile: { ...profile, assistant: { turn: turns.assistant, body, ...(thinking ? { thinking } : {}) }, user: { turn: turns.user } }, warnings };
  }
  if (role === "card") {
    const selector = learnSelector(picks.card, { onlyVisible: true });
    if (!selector) return { error: "Could not describe that box in a way that finds it again." };
    return { profile: { ...profile, card: { selector } }, warnings };
  }
  if (role === "limits") {
    // What this AI accepts: message size and commands per reply. Nothing set means the general preferences apply again.
    const { limits: _old, ...rest } = profile;
    const wanted = picks.limits || {};
    const limits = {};
    if (wanted.chars > 0) limits.chars = Math.round(wanted.chars);
    if (wanted.calls > 0) limits.calls = Math.round(wanted.calls);
    return { profile: Object.keys(limits).length ? { ...rest, limits } : rest, warnings };
  }
  return { error: `Unknown part "${role}".` };
}

/** What is wrong with a profile as stored (not whether the page still matches it). */
export function profileProblems(profile) {
  const problems = [];
  if (!profile || typeof profile !== "object") return ["not an object"];
  if (profile.version !== PROFILE_VERSION) problems.push(`unsupported version ${profile.version}`);
  if (typeof profile.site !== "string" || !profile.site) problems.push("no site");
  if (!profile.composer || typeof profile.composer.selector !== "string") problems.push("no composer selector");
  if (!profile.send || (typeof profile.send.selector !== "string" && profile.send.enter !== true)) problems.push("no send button and not Enter");
  if (!profile.assistant || typeof profile.assistant.turn !== "string") problems.push("no assistant turn selector");
  if (!profile.user || typeof profile.user.turn !== "string") problems.push("no user turn selector");
  if (profile.limits !== undefined) {
    const { limits } = profile;
    const ok = (value) => value === undefined || (Number.isFinite(value) && value > 0);
    if (!limits || typeof limits !== "object" || !ok(limits.chars) || !ok(limits.calls)) problems.push("limits must be positive numbers (chars, calls)");
  }
  return problems;
}
