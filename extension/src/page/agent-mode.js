// SPDX-License-Identifier: GPL-3.0-or-later
// The Agent / Discussion switch, kept per conversation. In Discussion the extension reads no reply, runs no command and injects
// nothing: loop.js, auto-resume.js and the system-prompt fallback all look at `state.discuss`. The choice is stored under the
// conversation's key, so a reload keeps it and another chat starts with the agent on.

const KEY = "zsDiscuss";
const KEEP = 200; // conversations remembered; beyond this some of the oldest choices are dropped

/** @param {{ state: object, provider: object, storage: object, onStop: () => void, onChange: () => void, diag: Function }} deps */
export function createAgentMode({ state, provider, storage, onStop, onChange, diag }) {
  let saved = {};
  let loaded = false;
  let shownKey = null;

  const keyOf = () => { try { return provider.conversationKey() || ""; } catch { return ""; } };
  const adopt = (value) => (value && typeof value === "object" ? { ...value } : {});

  function apply(wanted, key) {
    // Turning the agent off ends what it is doing.
    if (wanted && !state.discuss && (state.running || state.toolRunning)) onStop();
    // Back to Agent: nothing is acted on by itself. A command written meanwhile waits for Play or for the user's next message.
    if (!wanted && state.discuss) state.userStopped = true;
    state.discuss = wanted;
    shownKey = key;
    diag("agentMode", { discuss: wanted });
    onChange();
  }

  /** Follow the conversation on screen: each chat has its own switch. */
  function sync() {
    if (!loaded) return;
    const key = keyOf();
    const wanted = !!key && saved[key] === true;
    if (key === shownKey && wanted === state.discuss) return;
    apply(wanted, key);
  }

  storage.get(KEY).then((value) => { saved = { ...adopt(value), ...saved }; loaded = true; sync(); });
  storage.watch(KEY, (value) => { saved = adopt(value); sync(); });

  /** @returns {boolean} false when this chat has no id yet to keep the choice under */
  function set(value) {
    const key = keyOf();
    if (!key) return false;
    if (value) saved[key] = true; else delete saved[key];
    const keys = Object.keys(saved);
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete saved[old];
    storage.set(KEY, { ...saved });
    apply(value, key);
    return true;
  }

  return { sync, set, toggle: () => set(!state.discuss) };
}
