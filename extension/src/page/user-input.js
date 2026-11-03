// SPDX-License-Identifier: GPL-3.0-or-later
// A message the user types into the site. In a started session it begins a new agent turn; in a plain chat it is left alone.

const LOOP_START_DELAY_MS = 300;

/** @param {{ state: object, provider: object, bar: object, resend: object, loop: object, diag: Function }} deps */
export function installUserInput({ state, provider, bar, resend, loop, diag }) {
  provider.installSendHooks({
    isBlocked: () => state.injecting || state.running || state.starting,
    isStarted: () => state.started,
    onBlockedAttempt: () => bar.nudgeStart(),
    onUserMessage: (base) => {
      state.userStopped = false; // a new message is fresh intent
      resend.bump("users");
      state.sendToken = provider.lastAssistantId ? provider.lastAssistantId() : undefined;
      // A Stop clicked inside this delay is honoured: starting the loop anyway would strand the "Stopping…" flag.
      setTimeout(() => {
        if (!state.running && !state.userStopped) loop.run(base);
        else diag("loop.notStarted", { running: state.running, userStopped: state.userStopped });
      }, LOOP_START_DELAY_MS);
    },
  });
}
