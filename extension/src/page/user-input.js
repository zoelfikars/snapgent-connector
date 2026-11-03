// SPDX-License-Identifier: GPL-3.0-or-later
// A message the user types into the site. In a started session it begins a new agent turn; in a plain chat it is left alone.
// `takeOver` may claim a message first (one that tags files: the page sends it itself, with their contents).

const LOOP_START_DELAY_MS = 300;

/**
 * @param {{ document: Document, state: object, provider: object, bar: object, resend: object, loop: object, takeOver: () => boolean, diag: Function }} deps
 * @returns {{ startTurn: (base: *) => void }} `startTurn(base)` runs the agent on the reply that follows `base`
 */
export function installUserInput({ document, state, provider, bar, resend, loop, takeOver, diag }) {
  function startTurn(base) {
    state.userStopped = false; // a new message is fresh intent
    resend.bump("users");
    state.sendToken = provider.lastAssistantId ? provider.lastAssistantId() : undefined;
    // A Stop clicked inside this delay is honoured: starting the loop anyway would strand the "Stopping…" flag.
    setTimeout(() => {
      if (!state.running && !state.userStopped) loop.run(base);
      else diag("loop.notStarted", { running: state.running, userStopped: state.userStopped });
    }, LOOP_START_DELAY_MS);
  }

  const hooks = {
    isBlocked: () => state.injecting || state.running || state.starting,
    isStarted: () => state.started,
    onBlockedAttempt: () => bar.nudgeStart(),
    takeOver,
    onUserMessage: startTurn,
  };
  // The hooks belong to the provider that was current when they were made, and the calibrated one only arrives after the stored
  // profile is read (or when the user calibrates): they are made again each time the provider changes.
  let remove = () => {};
  const install = () => { remove(); remove = provider.installSendHooks(hooks) || (() => {}); };
  install();
  document.addEventListener("zs-provider-changed", install);
  return { startTurn };
}
