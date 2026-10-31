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
const CHROME_WORDS = 2;   // a label like "JSON" or "Copy code" may share a wrapper with the block and be hidden with it
const CHROME_CHARS = 24;
const SETTLE_MS = 150;        // let a rich editor learn where the caret is before input arrives

const isValueEditor = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
const byDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1); // 4: b follows a
const outermost = (list) => list.filter((el) => !list.some((other) => other !== el && other.contains(el)));

// Text compared without whitespace: an editor that makes each line its own paragraph holds the same words with no newline in them.
const squash = (text) => String(text).replace(/\s+/g, "");
const occurrences = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : 0);

export function createCalibratedProvider({ document, location, profile, diag = () => {}, now = Date.now, confirmMs = 5000 }) {
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
  // A chat with no turns has no identity yet: its URL is a placeholder (Gemini's is /app) that every new chat shares, and
  // remembering a started session under it would make every new chat look started.
  const conversationKey = () => (chatIsEmpty() || location.pathname === "/" ? "" : location.pathname);

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
  // The box that holds the text field together with its buttons (attach, mode, microphone, send): what the bar is seated in and
  // the cover lies over. The user may have pointed at it; otherwise it is the smallest ancestor with the field and two or more
  // controls (our own bar excluded, so seating the bar inside it does not change the answer).
  function composerFrame() {
    const editor = getEditor();
    if (!editor) return null;
    if (profile.card && profile.card.selector) {
      const chosen = find(profile.card.selector).find((box) => box.contains(editor));
      if (chosen) return chosen;
    }
    for (let n = editor.parentElement, i = 0; n && n !== document.body && i < 8; n = n.parentElement, i++) {
      const controls = [...n.querySelectorAll("button, [role=button]")].filter((b) => visible(b) && !b.closest("#zs-root"));
      if (controls.length >= 2) return n;
    }
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
    const want = squash(text.trim().slice(0, 30));
    const landed = () => squash(editorText()).includes(want);
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
    const probe = squash(text.trim().slice(0, 40));
    // Our own text on the page OUTSIDE the box: what we just typed into the box must not count as "it was sent".
    const shown = () => {
      const box = getEditor();
      return occurrences(squash(document.body.textContent || ""), probe) - (box ? occurrences(squash(box.textContent || ""), probe) : 0);
    };
    const shownBefore = shown();
    await writeComposer(text);
    // Accepted when any of: the box emptied, a new user turn, a stop button, the conversation got an id, our text is on the page.
    const accepted = () =>
      editorText().trim() === "" || userCount() > usersBefore || !!stopButton() || conversationKey() !== keyBefore || shown() > shownBefore;
    let sent;
    if (profile.send.selector) {
      if (!(await waitFor(sendReady, 30000))) throw new Error("The send button did not become available. Re-calibrate it.");
      sendButton().click();
      sent = await waitFor(accepted, confirmMs);
      if (!sent && sendButton()) { diag("calibrated.pressFallback", {}); pressed(sendButton()); sent = await waitFor(accepted, confirmMs); }
    } else {
      const editor = getEditor();
      const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ["keydown", "keypress", "keyup"]) editor.dispatchEvent(new win.KeyboardEvent(type, key));
      sent = await waitFor(accepted, confirmMs);
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
  // The raw command block is found by what it says, not by where a site puts it, and hidden together with the chrome that
  // belongs to it (a language label, a copy button). Climbing from the block, a parent is taken in only while everything
  // else in it is chrome: a button, an empty element, or a label of a word or two. A paragraph or a sentence is the reply
  // itself, and hiding it would make the answer vanish with the command.
  const isChrome = (sibling) => {
    if (sibling.nodeType !== 1) return !(sibling.textContent || "").trim();
    if (sibling.matches("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table, ul, ol") || sibling.querySelector("p, li, blockquote, pre, table")) return false;
    const words = (sibling.textContent || "").trim().split(/\s+/).filter(Boolean);
    return words.length <= CHROME_WORDS && words.join("").length <= CHROME_CHARS;
  };
  function blockWrapper(el, item, body) {
    let wrapper = el;
    for (let n = el.parentElement; n && n !== item && n !== body; n = n.parentElement) {
      if (![...n.childNodes].filter((child) => child !== wrapper).every(isChrome)) break;
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

  // ── what the profile finds on the page, for the calibration review ───────────
  function review() {
    const last = lastAssistant();
    const body = last ? bodyOf(last) : null;
    const codeBlocks = last ? [...last.querySelectorAll("pre")].filter((el) => !el.closest(".zs-chip")) : [];
    return {
      users: userTurns(), assistants: assistantTurns(), body: body && body !== last ? body : null, card: composerFrame(), composer: getEditor(), send: sendButton(),
      codeBlocks: codeBlocks.length, codeBlocksRead: body ? codeBlocks.filter((el) => body.contains(el)).length : codeBlocks.length,
    };
  }

  // ── health ────────────────────────────────────────────────────────────────
  function health() {
    const problems = profileProblems(profile).map((reason) => ({ role: "profile", reason }));
    if (!problems.length) {
      if (!getEditor()) problems.push({ role: "composer", reason: "text box not found" });
      // Some sites only draw the send button once there is text, so its absence in an empty box proves nothing.
      if (profile.send.selector && !sendButton() && editorText().trim() !== "") problems.push({ role: "send", reason: "send button not found" });
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
    chipAtItemLevel: false, // the chip takes the place of the hidden block, in the reply's own column (it is repainted if the site wipes it)
    init() {},
    modeWarning() {
      const { problems } = health();
      if (!problems.length) return "";
      const part = { composer: "Text box", send: "Send button" }[problems[0].role] || "Setup";
      return `${part} not found`;
    },
    health, describeLayout: health, testWrite, review,
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
