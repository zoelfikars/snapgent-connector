// SPDX-License-Identifier: GPL-3.0-or-later
// What the page knows about itself right now. One mutable object, shared by the page modules; nothing here is persisted.

export const createState = () => ({
  // When files may last have changed (a command ran, the workspace changed): a list of files read before is out of date.
  filesChangedAt: 0,
  // The session in this conversation. `startGen` identifies one bootstrap, so a start the user abandoned can tell it is dead.
  started: false,
  starting: false,
  startGen: 0,
  startingKey: null,
  bootBaselineId: null, // the reply already on screen when the session began: never resumed (a reload restores it)

  // The agent loop. `stopping` is the wind-down after Stop; `userStopped` keeps the watchdog from relaunching.
  running: false,
  stop: false,
  stopping: false,
  userStopped: false,
  stopAt: 0,
  stopStreamLen: 0,
  stopRetryAt: 0,
  loopKey: null,
  injecting: false,
  toolRunning: false,
  parked: false, // waiting for the tab to come back to the foreground

  // What the site is doing.
  lastGenAt: 0,
  maxTurnId: null,
  sendToken: undefined, // the last reply's identity before our send

  // The extension.
  bridge: { connected: false, mcpAlive: false, tools: 0 },
  staleExtension: false, // the page outlived its extension build; nothing works until a reload
});
