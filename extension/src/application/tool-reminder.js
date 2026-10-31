// SPDX-License-Identifier: GPL-3.0-or-later
// Cadence for re-sending the command list. A model that has drifted from the exact
// command names gets re-anchored every N successful calls, but not more often,
// because the reminder costs context.

export const REMIND_TOOLS_EVERY = 20;

export class ToolReminder {
  constructor({ every = REMIND_TOOLS_EVERY } = {}) {
    this._every = every;
    this._count = 0;
  }

  /** A fresh session starts a fresh cadence. */
  reset() { this._count = 0; }

  /**
   * Record one finished call; returns true when a reminder is due now.
   * Errors do not count (they already restate what is wrong) and neither does
   * list_commands (it is the reminder).
   */
  onResult({ isErr, tool, hasCatalogue }) {
    if (isErr || tool === "list_commands" || !hasCatalogue) return false;
    this._count++;
    if (this._count < this._every) return false;
    this._count = 0;
    return true;
  }
}
