// SPDX-License-Identifier: GPL-3.0-or-later
// What a batch already did when Stop ended it, so Play can carry on instead of starting over: the commands that finished (with the
// text the model is owed for them) and the one that was in flight. Kept in page memory, outside the DOM, under the same
// conversation + turn key as TurnMemory. A command counts as the same only while its tool and arguments are unchanged.

import { callSignature } from "../domain/tools/job-key.js";

const KEPT = 20; // replies remembered; the oldest go first

export class BatchProgress {
  /** @param {{ conversationKey: () => string, keyOf: (item: object) => string }} ports */
  constructor({ conversationKey, keyOf }) {
    Object.assign(this, { _conversation: conversationKey, _keyOf: keyOf });
    this._runs = new Map(); // "conversation|turnKey" -> { done: [{ sig, feedback, isErr }], interrupted: index|null }
  }

  _run(item, create) {
    try {
      const id = `${this._conversation()}|${this._keyOf(item)}`;
      let run = this._runs.get(id);
      if (!run && create) {
        run = { done: [], interrupted: null };
        this._runs.set(id, run);
        if (this._runs.size > KEPT) this._runs.delete(this._runs.keys().next().value);
      }
      return run || null;
    } catch { return null; } // the page may be mid-navigation; remembering is best effort
  }

  /** A command finished; `feedback` is exactly what the model is sent for it. */
  record(item, index, call, feedback, isErr) {
    const run = this._run(item, true);
    if (!run) return;
    run.done[index] = { sig: callSignature(call), feedback, isErr };
    run.interrupted = null;
  }

  /** Stop ended the batch while this command was in flight. */
  interrupt(item, index) {
    const run = this._run(item, true);
    if (run) run.interrupted = index;
  }

  wasInterrupted(item, index) {
    const run = this._run(item, false);
    return !!run && run.interrupted === index;
  }

  /** How many commands of this reply finished without the batch having been answered. */
  count(item) {
    const run = this._run(item, false);
    return run ? run.done.filter(Boolean).length : 0;
  }

  /**
   * The finished commands at the start of `calls` that are still the same commands: what a new run need not do again.
   * Whatever no longer matches (the reply was regenerated) is dropped.
   */
  resume(item, calls) {
    const run = this._run(item, false);
    if (!run) return [];
    const before = run.done.filter(Boolean).length;
    const reusable = [];
    for (let i = 0; i < calls.length && run.done[i] && run.done[i].sig === callSignature(calls[i]); i++) reusable.push(run.done[i]);
    run.done.length = reusable.length;
    if (reusable.length < before) run.interrupted = null;
    return reusable;
  }

  /** The batch was answered: a later run of this reply is a new one. */
  clear(item) {
    try { this._runs.delete(`${this._conversation()}|${this._keyOf(item)}`); } catch { /* see _run */ }
  }
}
