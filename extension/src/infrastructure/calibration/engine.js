// SPDX-License-Identifier: GPL-3.0-or-later
// A chat-site provider built from a profile (profile.js) instead of written per site. It implements the same object
// the page script has always talked to, so nothing above it changes. It knows no site: where things are comes from the
// profile; how to write into a composer and when a reply is finished are found by looking.

import { setNativeValue } from "../chat/dom-helpers.js";
import { StreamSampler } from "../chat/stream-sampler.js";
import { waitFor } from "../chat/wait.js";
import { alternativeSelectors, shown, visible } from "./dom-signals.js";
import { readText } from "./page-text.js";
import { profileProblems } from "./profile.js";

const TIMINGS = { GEN_IDLE_MS: 2000, REASON_IDLE_MS: 15000, WARMUP_MS: 60000, REASON_NOREPLY_MS: 120000, STABLE_MS: 10000, RESPONSE_TIMEOUT_MS: 300000 };
const STOP_LABEL = /\b(stop|cancel|halt|arr[êe]ter)\b/i;
const SETTLE_MS = 150;        // let a rich editor learn where the caret is before input arrives
const STOP_GONE_MS = 400;     // once a stop button has been seen for this reply, its disappearance ends the generation after this long

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

  // ── what was read from the page, kept until the page changes ────────────────
  // The agent loop asks the same questions several times per tick (the turns, the last reply's text). While nothing in the page has
  // changed the answer is the same, so it is worked out once. A change is noticed twice over: the observer's callback (changes of an
  // earlier task, already delivered) and `takeRecords()` (a change made a moment ago, not yet delivered).
  let watcher = null;
  const memo = new Map();
  function remembered(key, compute) {
    if (!watcher && typeof win.MutationObserver === "function") {
      watcher = new win.MutationObserver(() => memo.clear());
      watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    if (!watcher) return compute();
    if (watcher.takeRecords().length) memo.clear();
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  }

  // ── finding things ────────────────────────────────────────────────────────
  const find = (selector) => {
    try { return [...document.querySelectorAll(selector)].filter((el) => !el.closest("#zs-root")); } catch { return []; }
  };
  // A selector learned while the page was in one state can name things that change (a role, a placeholder, a state class). The controls
  // around the text box are looked up with it first and, when it finds nothing at all, with its other forms (see alternativeSelectors).
  const findLoose = (selector) => {
    const strict = find(selector);
    if (strict.length) return strict;
    for (const form of alternativeSelectors(selector)) {
      const found = find(form);
      if (found.length) return found;
    }
    return strict;
  };
  const firstVisible = (selector) => findLoose(selector).find(shown) || null;

  // ── turns ─────────────────────────────────────────────────────────────────
  // A turn is something laid out on the page: a template, a script or a collapsed copy that happens to carry the same attributes is
  // not a message, and would make an empty chat look started.
  const turnsOf = (selector) => outermost(find(selector).filter(visible));
  const assistantTurns = () => remembered("assistant", () => turnsOf(profile.assistant.turn)).slice();
  const userTurns = () => remembered("user", () => turnsOf(profile.user.turn)).slice();
  const allItems = () => [...new Set([...assistantTurns(), ...userTurns()])].sort(byDocumentOrder);
  const isUserItem = (item) => !!item && item.matches(profile.user.turn);
  const isAssistantItem = (item) => !!item && item.matches(profile.assistant.turn);
  const assistantCount = () => assistantTurns().length;
  const userCount = () => userTurns().length;
  const lastAssistant = () => assistantTurns().pop() || null;
  // Where the reply's words are. A turn with a "thinking" section holds the body selector TWICE (the thoughts, then the
  // answer): the answer is the LAST one. Taking the first read only the thoughts, so a command in the answer was never seen.
  const bodyOf = (item) => {
    if (!profile.assistant.body) return item;
    const matches = outermost([...item.querySelectorAll(profile.assistant.body)]);
    return matches.length ? matches[matches.length - 1] : item;
  };
  // The reasoning of a turn (when the profile names it) is not part of the reply: it may hold text that looks like a command.
  const thinkingParts = (item) => {
    if (!profile.assistant.thinking) return [];
    try { return outermost([...item.querySelectorAll(profile.assistant.thinking)]); } catch { return []; }
  };
  const bodyText = (item) => remembered(item, () => readText(bodyOf(item), profile.assistant.thinking));
  const thinkingKeys = new WeakMap();
  const thinkingText = (item) => {
    if (!item || !profile.assistant.thinking) return "";
    if (!thinkingKeys.has(item)) thinkingKeys.set(item, {});
    return remembered(thinkingKeys.get(item), () => thinkingParts(item).map((part) => readText(part)).join("\n"));
  };
  const itemText = (item) => (item ? (isAssistantItem(item) ? bodyText(item) : readText(item)) : "");
  const readAssistant = () => {
    const item = lastAssistant();
    return { present: !!item, reply: item ? bodyText(item).trim() : "", thinking: item ? thinkingText(item).trim() : "", item };
  };
  // A chat has begun when a message of the user's is on the page: the home page's cards, a greeting or an overlay that happens
  // to look like an AI turn do not make an empty chat look started.
  const chatIsEmpty = () => userTurns().length === 0;
  // A chat with no turns has no identity yet: its URL is a placeholder (Gemini's is /app) that every new chat shares, and
  // remembering a started session under it would make every new chat look started.
  const conversationKey = () => (chatIsEmpty() || location.pathname === "/" ? "" : location.pathname);

  // A stable key for a turn when the page gives one (an id-like attribute on the turn or inside it), else null.
  const ID_ATTRIBUTE = /message-id|msg-id|turn-id|item-id/;
  // An id does not change once a turn has one, so a found one is kept; looking is bounded to the first 200 elements and builds no list.
  const knownIds = new WeakMap();
  function idOf(item) {
    if (!item) return null;
    if (knownIds.has(item)) return knownIds.get(item);
    const walker = document.createTreeWalker(item, 1 /* SHOW_ELEMENT */);
    for (let el = item, seen = 0; el && seen < 200; el = walker.nextNode(), seen++) {
      for (const attr of el.attributes) {
        if (ID_ATTRIBUTE.test(attr.name) && attr.value) {
          const id = attr.value.split(" ")[0];
          knownIds.set(item, id);
          return id;
        }
      }
    }
    return null;
  }

  // ── composer ──────────────────────────────────────────────────────────────
  // The text box: by its selector; else by that selector's other forms; else the page's ONLY visible text box outside the turns (a new chat
  // and an open one often draw it differently). What was found that way is noted once in the log.
  const editable = (el) => isValueEditor(el) || (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false");
  let healed = "";
  const healedWith = (how, el) => { if (healed !== how) { healed = how; diag("composer.healed", { how, element: el.localName }); } return el; };
  function onlyTextBox() {
    const turns = [...assistantTurns(), ...userTurns()];
    const boxes = outermost(find("textarea, input:not([type]), input[type=text], [contenteditable]").filter(editable).filter(shown)).filter((box) => !turns.some((turn) => turn.contains(box)));
    return boxes.length === 1 ? boxes[0] : null;
  }
  // When several elements match, the one used last stays the one (the cover and the bar are glued to it: two candidates taking turns
  // would make them jump between two places); a new choice is the LAST one on the page, where the composer sits. What was chosen and
  // what else matched is noted once per change, for the report.
  let lastEditor = null;
  let lastNote = "";
  function pickEditor(candidates, how) {
    const list = candidates.filter(shown);
    const chosen = lastEditor && list.includes(lastEditor) ? lastEditor : list[list.length - 1] || null;
    const note = `${how}|${list.length}|${chosen ? chosen.localName + "." + String(chosen.className).slice(0, 40) : ""}`;
    if (chosen && (chosen !== lastEditor || list.length > 1) && note !== lastNote) {
      lastNote = note;
      const box = chosen.getBoundingClientRect();
      diag("composer.picked", { how, matches: list.length, index: list.indexOf(chosen), tag: chosen.localName, cls: String(chosen.className).slice(0, 60), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) });
    }
    if (chosen) lastEditor = chosen;
    return chosen;
  }
  const getEditor = () => {
    const named = pickEditor(find(profile.composer.selector), "selector");
    if (named) { healed = ""; return named; }
    for (const form of alternativeSelectors(profile.composer.selector)) {
      const found = pickEditor(find(form).filter(editable), `relaxed ${form}`);
      if (found) return healedWith(`selector ${form}`, found);
    }
    const only = onlyTextBox();
    return only ? healedWith("the only text box", only) : null;
  };
  const editorText = () => {
    const editor = getEditor();
    if (!editor) return "";
    return isValueEditor(editor) ? editor.value || "" : editor.textContent || "";
  };
  const isSendControl = (target) => target.closest(profile.send.selector) || alternativeSelectors(profile.send.selector).some((form) => target.closest(form));
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
      const chosen = findLoose(profile.card.selector).find((box) => box.contains(editor));
      if (chosen) return chosen;
    }
    // A box no bigger than the text field is the field's own wrapper, not the card it sits in.
    const inner = editor.getBoundingClientRect();
    for (let n = editor.parentElement, i = 0; n && n !== document.body && i < 8; n = n.parentElement, i++) {
      const box = n.getBoundingClientRect();
      if (box.width - inner.width < 8 && box.height - inner.height < 8) continue;
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

  /**
   * Put a file into the chat the way a person would: pasted into the text box, through the page's file input, or dropped on the box.
   * Nothing is sent. `handled` says only that the page reacted (a paste or drop it cancelled, an input that exists): what shows up is the page's business.
   */
  async function attachFile(file, method) {
    const editor = getEditor();
    if (!editor) throw new Error("The text box is not on the page. Re-calibrate it.");
    const data = new win.DataTransfer();
    data.items.add(file);
    editor.focus();
    await settle();
    if (method === "paste") {
      const event = new win.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      editor.dispatchEvent(event);
      return { method, handled: event.defaultPrevented };
    }
    if (method === "input") {
      const inputs = [...document.querySelectorAll("input[type=file]")].filter((el) => !el.closest("#zs-root"));
      if (!inputs.length) throw new Error("The page has no file input right now (some sites only make it when the + button is clicked).");
      const input = inputs[inputs.length - 1];
      input.files = data.files;
      for (const type of ["input", "change"]) input.dispatchEvent(new win.Event(type, { bubbles: true }));
      return { method, handled: true, inputs: inputs.length };
    }
    if (method === "drop") {
      const target = composerFrame() || editor;
      let handled = false;
      for (const type of ["dragenter", "dragover", "drop"]) {
        let event;
        if (typeof win.DragEvent === "function") event = new win.DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
        else { event = new win.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: data }); }
        target.dispatchEvent(event);
        if (type === "drop") handled = event.defaultPrevented;
      }
      return { method, handled };
    }
    throw new Error(`Unknown way to attach a file: ${method}`);
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
    // Reading the whole page's text is the costly signal: the cheap ones go first and this one is looked at twice a second at most.
    let shownAt = 0;
    const shownMore = () => {
      if (now() - shownAt < 500) return false;
      shownAt = now();
      return shown() > shownBefore;
    };
    await writeComposer(text);
    // Accepted when any of: the box emptied, a new user turn, a stop button, the conversation got an id, our text is on the page.
    const accepted = () =>
      editorText().trim() === "" || userCount() > usersBefore || !!stopButton() || conversationKey() !== keyBefore || shownMore();
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

  /**
   * The user sends a message (Enter, or the send button). `takeOver()` may claim it: the page then sends it itself, a moment later,
   * so the site must not see this click or key press. Returns a function that removes the hooks again.
   */
  function installSendHooks(handlers) {
    const sending = (e) => {
      if (!handlers.isStarted()) { if (chatIsEmpty()) handlers.onBlockedAttempt(); return; }
      if (handlers.takeOver && handlers.takeOver()) { e.preventDefault(); e.stopPropagation(); return; }
      handlers.onUserMessage(assistantCount());
    };
    const onKey = (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if (!editor || !editor.contains(e.target) || editorText().trim() === "" || handlers.isBlocked()) return;
      sending(e);
    };
    const onClick = (e) => {
      const button = sendButton();
      if (!button || !(e.target.closest && isSendControl(e.target)) || editorText().trim() === "" || handlers.isBlocked()) return;
      sending(e);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
    };
  }

  // ── generation ────────────────────────────────────────────────────────────
  // Reasoning counts as growth: without a stop button, a model that thinks for a long time must not look finished.
  const streamLen = (item) => {
    const turn = item === undefined ? lastAssistant() : item;
    return itemText(turn).length + thinkingText(turn).length;
  };
  const isHardGenerating = () => !!stopButton();
  // A stop button seen on THIS reply is a trustworthy signal: when it goes, the reply is over (a short grace covers a button that
  // blinks between the thinking and the answer). Only a reply that never showed one falls back on "the text grew in the last 2 s".
  let hardSeen = { item: null, at: 0 };
  const isGenerating = () => {
    const item = lastAssistant();
    sampler.sample(item, streamLen(item));
    if (isHardGenerating()) { hardSeen = { item, at: now() }; return true; }
    if (hardSeen.item && hardSeen.item === item) return now() - hardSeen.at < STOP_GONE_MS || sampler.grewWithin(STOP_GONE_MS);
    return sampler.grewWithin(TIMINGS.GEN_IDLE_MS);
  };
  const stopGeneration = () => { const button = stopButton(); if (button) try { button.click(); } catch { /* gone */ } };

  // ── what the profile finds on the page, for the calibration review ───────────
  function review() {
    const last = lastAssistant();
    const body = last ? bodyOf(last) : null;
    const codeBlocks = last ? [...last.querySelectorAll("pre")] : [];
    return {
      users: userTurns(), assistants: assistantTurns(), thinking: last ? thinkingParts(last) : [], body: body && body !== last ? body : null, card: composerFrame(), composer: getEditor(), send: sendButton(),
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
    limits: profile.limits || null,
    sendRetryLimit: 1,
    get reliableCounts() { return !!idOf(lastAssistant()); },
    init() {},
    modeWarning() {
      const { problems } = health();
      if (!problems.length) return "";
      const part = { composer: "Text box", send: "Send button" }[problems[0].role] || "Setup";
      return `${part} not found`;
    },
    health, describeLayout: health, testWrite, review,
    // What the profile finds right now, for a bug report: elements and sizes, never any text of the conversation.
    diagnose() {
      const matches = (selector) => find(selector).slice(0, 8).map((el) => ({ el, shown: visible(el), chars: readText(el).trim().length }));
      return {
        profile, health: health(), chatIsEmpty: chatIsEmpty(), isFreshChat: !!(chatIsEmpty() && getEditor()), key: conversationKey(), path: location.pathname,
        composer: getEditor(), card: composerFrame(), send: sendButton(),
        assistant: matches(profile.assistant.turn), user: matches(profile.user.turn),
        assistantCount: assistantCount(), userCount: userCount(),
      };
    },
    get needsCalibration() { return !health().ok; },

    allItems, isUserItem, isAssistantItem, itemText, assistantCount, userCount, lastAssistant,
    lastAssistantId: () => idOf(lastAssistant()), itemKey: idOf, readAssistant, chatIsEmpty,
    isFreshChat: () => chatIsEmpty() && !!getEditor(), conversationKey,

    isGenerating, isHardGenerating, isBusyNow: isGenerating, streamLen, snapshot: () => ({ th: 0, rp: streamLen() }),
    turnHalted: () => false, stopGeneration,

    getEditor, editorText, composerFrame, barAnchor: composerFrame, setInputLock() {}, installSendHooks,
    enforceComposer: () => ({ ready: !!getEditor() }), ensureComposerReady: async () => ({ ready: !!getEditor() }),
    typeAndSend, writeText: writeComposer, attachFile,

    scanError: () => null, isTooLongMsg: () => false, isBusyMsg: () => false,
    findContinueBtn: () => null, clickContinueBtn: () => false,
  };
}
