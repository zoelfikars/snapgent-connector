// SPDX-License-Identifier: GPL-3.0-or-later
// A chat-site provider built from a profile (profile.js) instead of written per site. It implements the same object
// the page script has always talked to, so nothing above it changes. It knows no site: where things are comes from the
// profile; how to write into a composer, when a reply is finished and where to put a chip are found by looking.

import { hasCommandShape } from "../../domain/parser/index.js";
import { setNativeValue } from "../chat/dom-helpers.js";
import { StreamSampler } from "../chat/stream-sampler.js";
import { waitFor } from "../chat/wait.js";
import { visible } from "./dom-signals.js";
import { readText } from "./page-text.js";
import { profileProblems } from "./profile.js";

const TIMINGS = { GEN_IDLE_MS: 2000, REASON_IDLE_MS: 15000, WARMUP_MS: 60000, REASON_NOREPLY_MS: 120000, STABLE_MS: 10000, RESPONSE_TIMEOUT_MS: 300000 };
const STOP_LABEL = /\b(stop|cancel|halt|arr[êe]ter)\b/i;
const CHROME_TEXT_LIMIT = 40; // header or "Copy" text a code block's wrapper may carry and still be hidden with it
const SETTLE_MS = 150;        // let a rich editor learn where the caret is before input arrives

const isValueEditor = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
const byDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1); // 4: b follows a
const outermost = (list) => list.filter((el) => !list.some((other) => other !== el && other.contains(el)));

export function createCalibratedProvider({ document, location, profile, diag = () => {}, now = Date.now }) {
  const win = document.defaultView;
  const sampler = new StreamSampler({ now, minLen: 1 });
  let preferredWrite = null; // the writing method that worked last time

  // ── finding things ────────────────────────────────────────────────────────
  const find = (selector) => {
    try { return [...document.querySelectorAll(selector)].filter((el) => !el.closest("#zs-root")); } catch { return []; }
  };
  const firstVisible = (selector) => find(selector).find(visible) || null;

  // ── turns ─────────────────────────────────────────────────────────────────
  const assistantTurns = () => outermost(find(profile.assistant.turn));
  const userTurns = () => outermost(find(profile.user.turn));
  const allItems = () => [...new Set([...assistantTurns(), ...userTurns()])].sort(byDocumentOrder);
  const isUserItem = (item) => !!item && item.matches(profile.user.turn);
  const isAssistantItem = (item) => !!item && item.matches(profile.assistant.turn);
  const assistantCount = () => assistantTurns().length;
  const userCount = () => userTurns().length;
  const lastAssistant = () => assistantTurns().pop() || null;
  const bodyOf = (item) => (profile.assistant.body && item.querySelector(profile.assistant.body)) || item;
  const itemText = (item) => (item ? readText(isAssistantItem(item) ? bodyOf(item) : item) : "");
  const classifyText = (item, exclude) => (item ? readText(isAssistantItem(item) ? bodyOf(item) : item, exclude) : "");
  const readAssistant = () => {
    const item = lastAssistant();
    return { present: !!item, reply: item ? readText(bodyOf(item)).trim() : "", thinking: "", item };
  };
  const chatIsEmpty = () => allItems().length === 0;
  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // A stable key for a turn when the page gives one (an id-like attribute on the turn or inside it), else null.
  const ID_ATTRIBUTE = /message-id|msg-id|turn-id|item-id/;
  function idOf(item) {
    if (!item) return null;
    for (const el of [item, ...item.querySelectorAll("*")].slice(0, 200)) {
      for (const attr of el.attributes) if (ID_ATTRIBUTE.test(attr.name) && attr.value) return attr.value.split(" ")[0];
    }
    return null;
  }

  // ── composer ──────────────────────────────────────────────────────────────
  const getEditor = () => firstVisible(profile.composer.selector);
  const editorText = () => {
    const editor = getEditor();
    if (!editor) return "";
    return isValueEditor(editor) ? editor.value || "" : editor.textContent || "";
  };
  const sendButton = () => (profile.send.selector ? firstVisible(profile.send.selector) : null);
  const sendReady = () => {
    const button = sendButton();
    return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
  };
  // The card around the composer: the nearest ancestor that also holds the send button.
  function composerFrame() {
    const editor = getEditor();
    if (!editor) return null;
    const send = sendButton();
    if (send) for (let n = editor.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) if (n.contains(send)) return n;
    return editor.closest("form") || editor.parentElement;
  }
  const stopButton = () => {
    if (profile.stop && profile.stop.selector) return firstVisible(profile.stop.selector);
    const scope = composerFrame() || document;
    for (const button of scope.querySelectorAll("button, [role=button]")) {
      if (!visible(button) || button.closest("#zs-root")) continue;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""} ${button.getAttribute("title") || ""}`;
      if (STOP_LABEL.test(label)) return button;
    }
    return null;
  };

  const selectContents = (el) => {
    const selection = win.getSelection && win.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  /** Put `text` in the composer and read it back. Methods are tried in turn and the one that works is remembered. */
  async function writeComposer(text) {
    const editor = getEditor();
    if (!editor) throw new Error("The text box is not on the page. Re-calibrate it.");
    const want = text.trim().slice(0, 30);
    const landed = () => editorText().includes(want);
    if (isValueEditor(editor)) {
      editor.focus();
      setNativeValue(editor, text, win);
      if (!landed()) throw new Error("The text box did not take the typed text.");
      return "value";
    }
    const methods = {
      paste: () => {
        const data = new win.DataTransfer();
        data.setData("text/plain", text);
        editor.dispatchEvent(new win.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      insertText: () => { document.execCommand("insertText", false, text); },
      beforeinput: () => { editor.dispatchEvent(new win.InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true })); },
    };
    const order = [preferredWrite, ...Object.keys(methods)].filter((name, i, list) => name && list.indexOf(name) === i);
    for (const name of order) {
      editor.focus();
      selectContents(editor);
      await settle();
      try { methods[name](); } catch { /* try the next way in */ }
      if (await waitFor(landed, 2500)) { preferredWrite = name; diag("calibrated.write", { via: name }); return name; }
    }
    throw new Error("The text box did not take the typed text. Click into it and try again.");
  }

  /** Empty the composer the way a person would (select all, delete) and confirm it is empty. */
  async function clearComposer() {
    const editor = getEditor();
    if (!editor) return false;
    if (isValueEditor(editor)) { editor.focus(); setNativeValue(editor, "", win); return editorText() === ""; }
    for (const attempt of [
      () => document.execCommand("delete"),
      () => editor.dispatchEvent(new win.InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true })),
    ]) {
      editor.focus();
      selectContents(editor);
      await settle();
      try { attempt(); } catch { /* try the next way */ }
      if (await waitFor(() => editorText().trim() === "", 1500)) return true;
    }
    return false;
  }

  /**
   * Calibration self-test: write a short text, read it back, empty the box. Nothing is sent.
   * @returns {{ ok: boolean, via?: string, cleared?: boolean, error?: string }}
   */
  async function testWrite() {
    try {
      const via = await writeComposer("snapgent test");
      const cleared = await clearComposer();
      return { ok: true, via, cleared };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  const pressed = (button) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        const Ctor = type.startsWith("pointer") && typeof win.PointerEvent === "function" ? win.PointerEvent : win.MouseEvent;
        button.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse" }));
      } catch { /* a button that cannot take this event */ }
    }
  };

  async function typeAndSend(text) {
    const usersBefore = userCount();
    const keyBefore = conversationKey();
    const probe = text.trim().slice(0, 40);
    const shown = () => (probe ? (document.body.textContent || "").split(probe).length - 1 : 0);
    const shownBefore = shown();
    await writeComposer(text);
    // Accepted when any of: the box emptied, a new user turn, a stop button, the conversation got an id, our text is on the page.
    const accepted = () =>
      editorText().trim() === "" || userCount() > usersBefore || !!stopButton() || conversationKey() !== keyBefore || shown() > shownBefore;
    let sent;
    if (profile.send.selector) {
      if (!(await waitFor(sendReady, 30000))) throw new Error("The send button did not become available. Re-calibrate it.");
      sendButton().click();
      sent = await waitFor(accepted, 5000);
      if (!sent && sendButton()) { diag("calibrated.pressFallback", {}); pressed(sendButton()); sent = await waitFor(accepted, 5000); }
    } else {
      const editor = getEditor();
      const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ["keydown", "keypress", "keyup"]) editor.dispatchEvent(new win.KeyboardEvent(type, key));
      sent = await waitFor(accepted, 5000);
    }
    if (!sent) throw new Error(`The page did not confirm the message was sent (text box: ${editorText().length} characters). Check the text box and try again.`);
  }

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if (!editor || !editor.contains(e.target) || editorText().trim() === "" || handlers.isBlocked()) return;
      if (!handlers.isStarted()) { if (chatIsEmpty()) handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (e) => {
      const button = sendButton();
      if (!button || !(e.target.closest && e.target.closest(profile.send.selector)) || editorText().trim() === "" || handlers.isBlocked()) return;
      if (!handlers.isStarted()) { if (chatIsEmpty()) handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  // ── generation ────────────────────────────────────────────────────────────
  const streamLen = (item) => (item === undefined ? itemText(lastAssistant()) : itemText(item)).length;
  const isHardGenerating = () => !!stopButton();
  const isGenerating = () => {
    const item = lastAssistant();
    sampler.sample(item, streamLen(item));
    return isHardGenerating() || sampler.grewWithin(TIMINGS.GEN_IDLE_MS);
  };
  const stopGeneration = () => { const button = stopButton(); if (button) try { button.click(); } catch { /* gone */ } };

  // ── chips ─────────────────────────────────────────────────────────────────
  // The raw command block is found by what it says, not by where a site puts it, and hidden with the chrome that
  // comes with it (a language label, a copy button): the largest ancestor that adds only a little text of its own.
  function blockWrapper(el, item, body) {
    let wrapper = el;
    const words = (node) => (node.textContent || "").replace(/\s+/g, "").length; // markup whitespace is not text
    const own = words(el);
    for (let n = el.parentElement; n && n !== item && n !== body; n = n.parentElement) {
      if (words(n) - own > CHROME_TEXT_LIMIT) break;
      wrapper = n;
    }
    return wrapper;
  }
  function findToolBlockSpot(item) {
    const body = bodyOf(item);
    let found = null;
    for (const el of item.querySelectorAll("pre, code, p, li")) {
      if (el.closest(".zs-chip, .zs-tool-hide")) continue;
      const text = (el.textContent || "").trim();
      if (!text || !hasCommandShape(text)) continue;
      const wrapper = blockWrapper(el, item, body);
      wrapper.classList.add("zs-tool-hide");
      found = found || { parent: wrapper.parentElement, ref: wrapper };
    }
    return found;
  }

  // ── health ────────────────────────────────────────────────────────────────
  function health() {
    const problems = profileProblems(profile).map((reason) => ({ role: "profile", reason }));
    if (!problems.length) {
      if (!getEditor()) problems.push({ role: "composer", reason: "text box not found" });
      if (profile.send.selector && !sendButton()) problems.push({ role: "send", reason: "send button not found" });
    }
    return { ok: problems.length === 0, problems, assistantTurns: assistantCount(), userTurns: userCount() };
  }

  return {
    id: String(profile.site).replace(/[^a-z0-9]+/gi, "-"),
    displayName: profile.name,
    timings: TIMINGS,
    supportsVision: false,
    sendRetryLimit: 1,
    get reliableCounts() { return !!idOf(lastAssistant()); },
    chipAtItemLevel: true,
    init() {},
    modeWarning() {
      const { problems } = health();
      return problems.length ? `Cannot find the ${problems[0].role} on this page. Re-calibrate it.` : "";
    },
    health, describeLayout: health, testWrite,
    get needsCalibration() { return !health().ok; },

    allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant,
    lastAssistantId: () => idOf(lastAssistant()), itemKey: idOf, readAssistant, chatIsEmpty,
    isFreshChat: () => chatIsEmpty() && !!getEditor(), conversationKey,

    isGenerating, isHardGenerating, isBusyNow: isGenerating, streamLen, snapshot: () => ({ th: 0, rp: streamLen() }),
    turnHalted: () => false, stopGeneration,

    getEditor, editorText, composerFrame, barAnchor: composerFrame, setInputLock() {}, installSendHooks,
    enforceComposer: () => ({ ready: !!getEditor() }), ensureComposerReady: async () => ({ ready: !!getEditor() }),
    typeAndSend, attachImages: () => false, clearAttachments() {},

    findToolBlockSpot, scanError: () => null, isTooLongMsg: () => false, isBusyMsg: () => false,
    findContinueBtn: () => null, clickContinueBtn: () => false,
  };
}
