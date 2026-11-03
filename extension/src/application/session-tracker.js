// SPDX-License-Identifier: GPL-3.0-or-later
// Whether the open conversation is a snapgentV3 session, and what to do when the user moves to another
// conversation while a bootstrap or a loop is still bound to the old one.
//
// Sites virtualize their message lists, so the system-prompt turn is dropped from the DOM once it scrolls
// away. "Started" is therefore remembered per conversation key (persisted, so it survives reloads) and
// only recomputed when the key changes. Pure decisions: the page applies the returned actions.

import { LEGACY_SESSION_MARKER } from "../domain/constants.js";
import { containsResult } from "../domain/tools/result-marker.js";

const KEY = "zsStartedSessions";
const REMEMBER_LIMIT = 300;

/**
 * Does this turn's text prove the chat is a session? The start message's own words, an injected tool result or a system
 * note do. A bare {"command":...} deliberately does not: a model explaining the format in a plain chat is not a session,
 * and treating it as one executed quoted JSON in a chat with no agent. A command only counts once it RAN, and a run is
 * always followed by our injected result turn, which is caught here.
 */
export function textShowsSession(text, sessionPhrase) {
  return text.includes(sessionPhrase) || text.includes(LEGACY_SESSION_MARKER) || containsResult(text) || text.includes("(System note:");
}

export class SessionTracker {
  /** @param {{ store: { get: (key: string) => Promise<*>, set: (key: string, value: *) => void } }} deps */
  constructor({ store }) {
    this._store = store;
    this._started = new Set();
    this._lastPath = null;
    /** Resolves once the persisted keys are loaded; the page re-syncs then. */
    this.ready = this._load();
  }

  async _load() {
    try {
      const saved = await this._store.get(KEY);
      if (Array.isArray(saved)) for (const path of saved) this._started.add(path);
    } catch { /* start with none remembered */ }
  }

  /** A falsy key is a transient URL (an id not yet assigned); remembering it would mark every future fresh chat as started. */
  remember(path) {
    if (!path || this._started.has(path)) return;
    this._started.add(path);
    this._store.set(KEY, [...this._started].slice(-REMEMBER_LIMIT));
  }

  /**
   * @param {{ starting: boolean, startingKey: string|null, running: boolean, loopKey: string|null, injecting: boolean,
   *           started: boolean, key: string, chatEmpty: boolean, markerInDom: () => boolean }} f
   *   `markerInDom` is a function because scanning the page is only worth it when the answer can matter.
   * @returns {{ startingKey: string|null|undefined, abandonStart: boolean, loopKey: string|null|undefined, abandonLoop: boolean, started: boolean|undefined }}
   *   A key of `undefined` means leave it; `started` is only present when it changes.
   */
  decide(f) {
    const out = { startingKey: undefined, abandonStart: false, loopKey: undefined, abandonLoop: false, started: undefined };
    // A bootstrap's chat only gets its real id after the prompt lands ("/app" -> "/app/<id>"), so pin the id the first
    // time the chat has content. Another, EMPTY chat means the user opened a new conversation: abandon the bootstrap.
    if (f.starting) {
      if (f.startingKey == null) {
        if (f.key && !f.chatEmpty) out.startingKey = f.key;
      } else if (f.key !== f.startingKey && f.chatEmpty) {
        out.abandonStart = true;
        out.startingKey = null;
      }
    }
    // The same for a running loop, if the user uses the SITE's own new-chat button. The id assignment of the same chat is
    // not a move: the loop key is pinned only once the chat has both an id and content.
    if (f.running) {
      if (f.loopKey == null) {
        if (f.key && !f.chatEmpty) out.loopKey = f.key;
      } else if (f.key !== f.loopKey && f.chatEmpty) {
        out.abandonLoop = true;
        out.loopKey = null;
      }
    }
    if (f.starting || f.injecting || f.running) return out;

    const marker = f.markerInDom();
    if (marker) this.remember(f.key);
    const known = !!f.key && this._started.has(f.key);
    let has;
    if (f.key && f.key === this._lastPath) {
      // Same real conversation: never downgrade a started session because the marker scrolled out. A falsy key is never
      // sticky, or a transient sweep during navigation would pin "started" onto the next empty chat.
      has = f.started || marker || known;
    } else {
      has = marker || known;
      this._lastPath = f.key;
    }
    if (has !== f.started) out.started = has;
    return out;
  }
}
