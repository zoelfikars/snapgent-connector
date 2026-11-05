// SPDX-License-Identifier: GPL-3.0-or-later
// Waits for the model to finish replying and classifies the reply. Driven by the
// site's "generating" flag plus text stability, because DOM structure churns.
//
// Each tick runs a fixed sequence of GATES. A gate either lets the tick pass, asks
// to wait a moment (the reply is not settled yet), or ends the wait with a result.
// Order matters and is documented at each gate.

import { classifyReply, looksLikeCommand } from "../domain/agent/reply-classifier.js";
import { hasOpenToolBlock } from "../domain/parser/index.js";
import { WatchState } from "./watch-state.js";

const NO_TURN_GRACE_MS = 30000;      // never finalize on a PREVIOUS turn's text for longer than this
const UNSETTLED_GRACE_MS = 8000;     // max hold-off while a provider reports its read is unsettled
const GEN_STOP_GRACE_MS = 2500;      // gen off this long => an "open tool block" is DOM churn, not live output
const OPEN_BLOCK_QUIET_MS = 6000;    // an open block only counts as streaming while the text keeps changing
const PRE_START_SILENCE_MS = 60000;  // a reply turn that never appears
const UNREADABLE_MS = 15000;         // generating, yet no reply turn is found: the page layout is not understood
const SETTLE_MS = 250;               // DOM must be stable this long before we parse

const pass = null;
const wait = (ms) => ({ wait: ms });
const finish = (result) => ({ done: result });

export class ResponseWatcher {
  /**
   * @param {{
   *   chat: import("./ports.js").ReplyReaderPort,
   *   visibility: { isHidden: () => boolean, parkHidden: () => Promise<number> },
   *   isStopped: () => boolean,
   *   sendToken: () => *,
   *   clock: { now: () => number, sleep: (ms: number) => Promise<void> },
   *   timings: { RESPONSE_TIMEOUT_MS: number, STABLE_MS: number, WARMUP_MS: number, REASON_NOREPLY_MS: number },
   *   knowsTool: (name: string) => boolean,
   *   catalogueSize: () => number,
   *   describeLayout?: () => object,   // what the page looks like, logged when replies cannot be read
   *   diag?: (event: string, data?: object) => void,
   *   phase?: (name: "waiting"|"writing"|"checking"|"reading") => void,   // what the watcher is doing now
   * }} deps
   */
  constructor(deps) {
    this._d = deps;
    this._diag = deps.diag || (() => {});
    this._say = deps.phase || (() => {});
  }

  /** @param {number} base assistant-turn count before the send (fallback for "is there a new reply") */
  async wait(base) {
    const { clock, timings } = this._d;
    const s = new WatchState(clock.now);
    this._phase = ""; 
    while (clock.now() - s.lastActiveAt < timings.RESPONSE_TIMEOUT_MS) {
      const verdict = await this._tick(base, s);
      if (verdict && verdict.done) return verdict.done;
      if (verdict && verdict.wait) await clock.sleep(verdict.wait);
    }
    return { kind: "timeout" };
  }

  _is(phase) { if (this._phase !== phase) this._say((this._phase = phase)); } // what is being waited for, said once per change

  async _tick(base, s) {
    const { chat, visibility, isStopped } = this._d;
    if (isStopped()) return finish({ kind: "stopped" });

    // A hidden tab has no layout and throttled timers, so every read is unreliable and the site may
    // legitimately keep streaming. Park, then slide every deadline forward by the time parked.
    if (visibility.isHidden()) {
      const parked = await visibility.parkHidden();
      if (isStopped()) return finish({ kind: "stopped" });
      if (parked) s.shift(parked);
      return wait(0); // re-read everything now that the tab has layout again
    }

    const gen = chat.isGenerating();
    if (gen) s.lastActiveAt = s.now(); // actively generating => never time out
    const d = chat.readAssistant();
    const newReply = this._hasNewReply(base);
    s.observeTurn(d);

    const early = this._gatePreStart(s, d, gen, newReply);
    if (early) return early;
    s.observeStability(d, gen);

    return (
      this._gateContextLimit(s) ||
      this._gateUnreadable(s, d) ||
      this._gateStreaming(s, d, gen) ||
      this._gateNoTurnYet(s, d, gen, newReply, base) ||
      this._gateSettle(s) ||
      this._gateWarmup(s, d) ||
      this._gateReasoning(s, d) ||
      (await this._finalize(s, d))
    );
  }

  /** Is there a reply for THIS send? By node identity (virtualisation-proof); with no readable id, by the turn count. */
  _hasNewReply(base) {
    const { chat, sendToken } = this._d;
    const current = chat.lastAssistantId ? chat.lastAssistantId() : undefined;
    return current !== undefined && current !== null ? current !== sendToken() : chat.assistantCount() > base;
  }

  /** Before the reply starts: a bare empty container is not a reply; require content or the generating flag. */
  _gatePreStart(s, d, gen, newReply) {
    if (s.started) return pass;
    const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
    if (gen || (newReply && hasText)) { s.started = true; return pass; }
    if (!s.preStartSilent) s.preStartSilent = s.now();
    if (s.now() - s.preStartSilent > PRE_START_SILENCE_MS) {
      this._diag("empty.why", { branch: "preStart", rep: (d.reply || "").length });
      return finish({ kind: "empty" });
    }
    this._is("waiting");
    return wait(200);
  }

  _gateContextLimit(s) {
    if (s.now() - s.lastLimitScan <= 1000) return pass;
    s.lastLimitScan = s.now();
    const detail = this._d.chat.scanError();
    return detail ? finish({ kind: "context_limit", detail }) : pass;
  }

  /** The site says it is generating but no reply turn is found: the page layout is not understood, and waiting cannot help. */
  _gateUnreadable(s, d) {
    if (d.item || !s.started) { s.unreadableSince = 0; return pass; }
    if (!s.unreadableSince) s.unreadableSince = s.now();
    if (s.now() - s.unreadableSince < UNREADABLE_MS) return pass;
    this._diag("layout.unreadable", this._d.describeLayout ? this._d.describeLayout() : {});
    return finish({ kind: "unreadable" });
  }

  /** Keep waiting while the model is still writing: generating, or a command block opened but not closed. */
  _gateStreaming(s, d, gen) {
    const { timings } = this._d;
    const blockActive = hasOpenToolBlock(d.reply) && s.now() - s.lastChangeAt < OPEN_BLOCK_QUIET_MS;
    const genStopped = !gen && s.genFalseSince && s.now() - s.genFalseSince > GEN_STOP_GRACE_MS;
    const effectiveBlock = blockActive && !genStopped;
    // Generating flag stuck ON (a wedged stop button) but the text frozen: finalize anyway.
    // Never when a command block is still open while generating: that is a mid-write pause, not a wedge.
    const stuckDone = s.started && d.reply && s.now() - s.lastChangeAt > timings.STABLE_MS &&
      !(gen && hasOpenToolBlock(d.reply));
    if ((gen || effectiveBlock) && !stuckDone) {
      if (s.genOffFirstAt) { if (gen) s.waitedFlicker++; else if (effectiveBlock) s.waitedBlock++; }
      s.doneSince = 0;
      this._is("writing");
      return wait(160);
    }
    if (stuckDone && gen) this._diag("watcher.stuckGen");
    return pass;
  }

  /**
   * On providers with reliable turn counts the generating flag can flicker off between the send and the
   * new reply node appearing; never finalize on the PREVIOUS turn's stable text. Bounded by a grace.
   */
  _gateNoTurnYet(s, d, gen, newReply, base) {
    const { chat, sendToken } = this._d;
    if (!(chat.reliableCounts && !newReply)) {
      s.noTurnSince = s.noTurnLoggedAt = 0;
      return pass;
    }
    if (!s.noTurnSince) s.noTurnSince = s.now();
    const waited = s.now() - s.noTurnSince;
    if (waited > 800 && (!s.noTurnLoggedAt || s.now() - s.noTurnLoggedAt > 3000)) {
      s.noTurnLoggedAt = s.now();
      this._diag("noTurnGrace.wait", {
        waitedMs: waited,
        curTok: chat.lastAssistantId ? chat.lastAssistantId() : undefined,
        sendToken: sendToken(),
        assistantCount: chat.assistantCount(),
        base, gen, started: s.started, replyLen: (d.reply || "").length,
      });
    }
    return waited < NO_TURN_GRACE_MS ? (this._is(s.started ? "checking" : "waiting"), wait(200)) : pass;
  }

  /** Everything above says "done"; require it to hold for a moment so the DOM is stable. */
  _gateSettle(s) {
    if (!s.doneSince) s.doneSince = s.now();
    return s.now() - s.doneSince < SETTLE_MS ? (this._is("checking"), wait(120)) : pass;
  }

  /** A turn that has produced NOTHING yet is warming up: never finalize it as empty/truncated/text. */
  _gateWarmup(s, d) {
    if (s.sawContent) return pass;
    if (!s.warmSince) s.warmSince = s.now();
    if (s.now() - s.warmSince < this._d.timings.WARMUP_MS) return wait(200);
    this._diag("empty.why", { branch: "warmup", rep: (d.reply || "").length, lastGood: s.lastGoodReply.length });
    return finish({ kind: "empty" });
  }

  /** Reasoning written but no answer yet: wait for the answer, bounded. A halted turn still ends. */
  _gateReasoning(s, d) {
    const reasoningOnly = d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !this._d.chat.turnHalted(d.item);
    if (!reasoningOnly) { s.reasonSince = 0; return pass; }
    if (!s.reasonSince) s.reasonSince = s.now();
    return s.now() - s.reasonSince < this._d.timings.REASON_NOREPLY_MS ? wait(200) : pass;
  }

  /** The reply is settled: apply the last holds, then classify it. */
  async _finalize(s, d) {
    const { chat } = this._d;
    this._is("reading");
    // Blank-read guard: this read came back empty but the same turn had real text a tick ago.
    let reply = d.reply;
    if (!reply && s.lastGoodReply) {
      reply = s.lastGoodReply;
      this._diag("reply.blankReadFallback", { len: reply.length });
    }
    // "Conversation too long" notices are short system messages; the length gate keeps the model's own
    // long output (which may quote them) from tripping this.
    if (reply.length < 400 && chat.isTooLongMsg(reply)) return finish({ kind: "too_long" });

    // Hold off any "unparseable command" verdict while the provider says this read is not settled yet.
    if (chat.replyUnsettled && looksLikeCommand(reply) && chat.replyUnsettled(d.item)) {
      if (!s.unsettledSince) s.unsettledSince = s.now();
      if (s.now() - s.unsettledSince < UNSETTLED_GRACE_MS) return wait(250);
    } else {
      s.unsettledSince = 0;
    }

    // A/B "carousel" turn: the composer is gone until a candidate is picked. Wait for both to finish,
    // then select the first so the normal parse/run path can continue.
    if (chat.isComparisonTurn && chat.isComparisonTurn(d.item)) {
      if (chat.isGenerating()) return wait(250);
      if (chat.resolveComparison && chat.resolveComparison()) {
        this._diag("carousel.resolved");
        return wait(400);
      }
      return wait(250);
    }

    const { result, diags } = classifyReply(reply, {
      item: d.item,
      hasContinueButton: () => !!chat.findContinueBtn(),
      knowsTool: this._d.knowsTool,
      catalogueSize: this._d.catalogueSize(),
    });
    for (const [event, data] of diags) this._diag(event, data);
    if (result.kind === "tool") this._diag("stopGoneToResp", s.latency("tool"));
    return finish(result);
  }
}
