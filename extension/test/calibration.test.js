import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ZSParse from "../src/domain/parser/index.js";
import { createCalibratedProvider, learnProfile, learnSelector, profileProblems } from "../src/infrastructure/calibration/index.js";
import { pageWith } from "./support/jsdom-provider.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const MARKER = "⟦ZS-SYS⟧";

// ── what the user would click, per site, on a captured page ─────────────────────────────────────────────────────
// The ChatGPT reply chain and the Gemini reply structure are captured; the composers and send buttons of those two,
// and the whole of the Meta page's reply, are written to match what was reported, so the composer/send half is
// synthetic. The profile is learned from the clicks, never written by hand.
const SITES = {
  chatgpt: {
    hostname: "chatgpt.com", name: "ChatGPT", url: "https://chatgpt.com/c/test",
    html: () => fixture("chatgpt-search-units-2026-10.html").replace("</main>", `</main><form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div><button data-testid="send-button" aria-label="Send prompt"></button></form>`),
    clicks: (d) => ({ composer: d.querySelector("#prompt-textarea"), send: d.querySelector('[data-testid="send-button"]'), assistant: d.querySelector("pre"), user: d.querySelector(".whitespace-pre-wrap"), assistantInner: d.querySelector("[data-markdown-text-style]") }),
    editor: "contenteditable", codeBlock: '[data-code-block="true"]',
  },
  gemini: {
    hostname: "gemini.google.com", name: "Gemini", url: "https://gemini.google.com/app/x",
    html: () => fixture("sites/gemini.html").replace("</input-area-v2>", `<button aria-label="Send message"></button></input-area-v2>`),
    clicks: (d) => ({ composer: d.querySelector(".ql-editor"), send: d.querySelector('button[aria-label="Send message"]'), assistant: d.querySelector("code-block"), user: d.querySelector(".query-text"), assistantInner: d.querySelector("message-content") }),
    editor: "contenteditable", codeBlock: "code-block",
  },
  meta: {
    hostname: "www.meta.ai", name: "Meta AI", url: "https://www.meta.ai/prompt/x",
    html: () => fixture("sites/meta-lexical.html"),
    clicks: (d) => ({ composer: d.querySelector("[data-lexical-editor]"), send: d.querySelector('[data-testid="composer-send-button"]'), assistant: d.querySelector("pre"), user: d.querySelector(".user-turn div"), assistantInner: null }),
    editor: "contenteditable", codeBlock: ".ur-code-block",
  },
};

function calibrated(site, { mutate } = {}) {
  const { window, document } = pageWith(site.html(), site.url);
  if (mutate) mutate(document);
  const learned = learnProfile({ hostname: site.hostname, name: site.name, picks: site.clicks(document) });
  assert.equal(learned.error, undefined, learned.error);
  const events = [];
  const provider = createCalibratedProvider({ document, location: window.location, profile: learned.profile, diag: (event, data) => events.push([event, data]) });
  return { window, document, provider, profile: learned.profile, warnings: learned.warnings, events };
}

for (const [key, site] of Object.entries(SITES)) {
  describe(`${site.name}: a profile learned from four clicks reads the page`, () => {
    test("the profile is complete and the page matches it", () => {
      const { profile, provider, warnings } = calibrated(site);
      assert.deepEqual(profileProblems(profile), []);
      assert.deepEqual(provider.health().problems, []);
      assert.deepEqual(warnings, []);
    });

    test("counts one user turn and one assistant turn and tells them apart", () => {
      const { provider } = calibrated(site);
      assert.deepEqual([provider.userCount(), provider.assistantCount()], [1, 1]);
      const items = provider.allItems();
      assert.deepEqual([items.filter(provider.isUserItem).length, items.filter(provider.isAssistantItem).length], [1, 1]);
      assert.equal(items.filter(provider.isUserItem).some(provider.isAssistantItem), false, "no turn is both");
    });

    test("reads the tool call out of the reply and it parses", () => {
      const { provider } = calibrated(site);
      const [call] = ZSParse.parseToolCalls(provider.readAssistant().reply);
      assert.ok(call && call.tool, provider.readAssistant().reply);
    });

    test("the user turn exposes the session marker", () => {
      const { provider } = calibrated(site);
      const user = provider.allItems().find(provider.isUserItem);
      assert.ok(provider.classifyText(user, ".zs-chip").includes(MARKER));
    });

    test("finds the composer, and the card around it holds the send button", () => {
      const { provider, document } = calibrated(site);
      assert.ok(provider.getEditor());
      assert.ok(provider.composerFrame().contains(document.querySelector("[aria-label^='Send'], [data-testid='send-button'], [data-testid='composer-send-button']")));
    });

    test("finds the raw command block and hides it with its chrome", () => {
      const { provider, document } = calibrated(site);
      assert.ok(provider.findToolBlockSpot(provider.lastAssistant()), "a place to put the chip");
      assert.ok(document.querySelector("pre").closest(".zs-tool-hide"), "the block is hidden");
      assert.ok(document.querySelector(site.codeBlock).closest(".zs-tool-hide"), "and so is the whole block around it (its header, its copy button)");
    });

    test("a visible Stop control means it is generating, and it is idle without one", () => {
      const { provider, document } = calibrated(site);
      assert.equal(provider.isHardGenerating(), false);
      provider.composerFrame().insertAdjacentHTML("beforeend", '<button aria-label="Stop generating"></button>');
      assert.equal(provider.isHardGenerating(), true);
      assert.ok(document.querySelector('[aria-label="Stop generating"]'));
    });

    test("is a fresh chat only when there are no turns", () => {
      const { provider, document } = calibrated(site);
      assert.equal(provider.isFreshChat(), false);
      for (const turn of provider.allItems()) turn.remove();
      assert.equal(provider.chatIsEmpty(), true);
      assert.equal(provider.isFreshChat(), true);
      assert.ok(document);
    });
  });
}

describe("what a re-skin must not break", () => {
  test("ChatGPT: generated class names changing does not lose the turns", () => {
    const renamed = calibrated(SITES.chatgpt);
    const { provider, document } = renamed;
    for (const el of document.querySelectorAll("[class]")) el.className = el.className.replace(/-[A-Za-z0-9]{6}\b/g, "-Zz9Qw1");
    assert.deepEqual([provider.userCount(), provider.assistantCount()], [1, 1]);
    assert.ok(ZSParse.parseToolCalls(provider.readAssistant().reply)[0]);
  });

  test("ChatGPT: a new turn with a new id is found by the same profile", () => {
    const { provider, document } = calibrated(SITES.chatgpt);
    const reply = document.querySelector('[data-content-search-unit-key$=":assistant"]').parentElement;
    const next = reply.cloneNode(true);
    for (const el of [next, ...next.querySelectorAll("*")]) for (const attr of [...el.attributes]) el.setAttribute(attr.name, attr.value.replace("fallback-turn-1:1", "fallback-turn-7:7"));
    document.querySelector("main").appendChild(next);
    assert.equal(provider.assistantCount(), 2);
  });

  test("the profile survives a JSON round trip (that is what is stored)", () => {
    const { profile, document, window } = calibrated(SITES.gemini);
    const stored = JSON.parse(JSON.stringify(profile));
    const provider = createCalibratedProvider({ document, location: window.location, profile: stored });
    assert.equal(provider.assistantCount(), 1);
  });
});

describe("health and re-calibration", () => {
  test("a missing text box is named, and the bar is told why Start cannot run", () => {
    const { provider, document } = calibrated(SITES.gemini);
    document.querySelector(".ql-editor").remove();
    const health = provider.health();
    assert.equal(health.ok, false);
    assert.equal(health.problems[0].role, "composer");
    assert.equal(provider.modeWarning(), "Text box not found");
  });

  test("a missing send button is named once there is text to send", () => {
    const { provider, document } = calibrated(SITES.chatgpt);
    document.querySelector('[data-testid="send-button"]').remove();
    document.querySelector("#prompt-textarea").textContent = "hello";
    assert.equal(provider.health().problems[0].role, "send");
    assert.equal(provider.modeWarning(), "Send button not found");
  });

  test("a send button that only appears with text (Gemini) is not a problem while the box is empty", () => {
    const { provider, document } = calibrated(SITES.gemini);
    document.querySelector('button[aria-label="Send message"]').remove();
    assert.equal(provider.getEditor().textContent, "");
    assert.deepEqual(provider.health().problems, []);
    assert.equal(provider.modeWarning(), "");
    assert.equal(provider.needsCalibration, false);
  });

  test("a healthy page says nothing", () => {
    assert.equal(calibrated(SITES.meta).provider.modeWarning(), "");
  });

  test("a click that cannot be described is reported, not guessed", () => {
    const { document } = pageWith(`<body><div><div><span>a</span></div></div><div><div><span>b</span></div></div></body>`);
    const result = learnProfile({
      hostname: "x.test", name: "X",
      picks: { composer: document.querySelector("span"), send: null, assistant: document.querySelectorAll("span")[0], user: document.querySelectorAll("span")[1] },
    });
    assert.ok(result.error, "nothing stable to learn from");
  });
});

describe("selector learning", () => {
  test("generated classes are never trusted, chosen ones are", () => {
    const { document } = pageWith(`<body><div class="block-BQZwFn reply"></div><div class="block-BQZwFn"></div></body>`);
    const [a, b] = document.querySelectorAll("div");
    assert.equal(learnSelector(a), ".reply");
    assert.equal(learnSelector(b), null);
  });

  test("an instance-specific attribute is generalised to the part that does not change", () => {
    const { document } = pageWith(`<body><i data-k="turn-1:1:assistant"></i><i data-k="turn-2:2:user"></i></body>`);
    const [a, u] = document.querySelectorAll("i");
    assert.equal(learnSelector(a, { avoid: [u] }), '[data-k$=":assistant"]');
  });

  test("it never returns a selector that also finds what it must be told apart from", () => {
    const { document } = pageWith(`<body><b data-role="x" class="one"></b><b data-role="x" class="two"></b></body>`);
    const [one, two] = document.querySelectorAll("b");
    const selector = learnSelector(one, { avoid: [two] });
    assert.deepEqual([...document.querySelectorAll(selector)], [one]);
    assert.equal(selector, ".one");
  });

  test("when several elements share the selector, the one that is visible and unique is wanted", () => {
    const { document } = pageWith(`<body><div class="hidden"><textarea data-testid="box"></textarea></div><div data-testid="box" id="live"></div></body>`);
    const live = document.getElementById("live");
    assert.equal(learnSelector(live, { onlyVisible: true, unique: true }), '[data-testid="box"]');
  });
});

// What a send does on the stand-in sites: it takes what is in the box and empties it.
function document_submit(editor, state) {
  editor.ownerDocument.addEventListener("click", (event) => {
    if (event.target.closest && event.target.closest("button") && editor.textContent.trim()) { state.sent.push(editor.textContent); editor.textContent = ""; }
  });
}

describe("writing and sending", () => {
  // A stand-in for a rich editor: it takes a paste, and only once its caret has settled; the send button reads it.
  function liveSite(key, { enter = false } = {}) {
    const site = SITES[key];
    const page = calibrated(site, { mutate: undefined });
    const { document, provider, window } = page;
    const editor = provider.getEditor();
    const state = { sent: [], settledAt: 0 };
    const nativeFocus = editor.focus.bind(editor);
    editor.focus = () => { state.settledAt = Date.now(); nativeFocus(); };
    editor.addEventListener("paste", (event) => { if (Date.now() - state.settledAt >= 100) editor.textContent = event.clipboardData.getData("text/plain"); });
    const submit = () => { if (!editor.textContent.trim()) return; state.sent.push(editor.textContent); editor.textContent = ""; };
    document.addEventListener("click", (event) => { if (event.target.closest && event.target.closest("button")) submit(); });
    editor.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    return { ...page, editor, state, window, enter };
  }

  for (const key of Object.keys(SITES)) {
    test(`${SITES[key].name}: the message is written into the box, read back, and sent with the button`, async () => {
      const { provider, state, window } = liveSite(key);
      await provider.typeAndSend("⟦ZS-SYS⟧ first message", []);
      assert.deepEqual(state.sent, ["⟦ZS-SYS⟧ first message"]);
      window.close();
    });
  }

  // The real bootstrap message starts "⟦ZS-SYS⟧\nCONTEXT: ...". Rich editors (ProseMirror, Lexical) keep each line as its own
  // paragraph, so the text they hold has no newline in it; a plain <textarea> keeps it.
  test("a message whose first line break becomes a paragraph boundary is still recognised as written", async () => {
    const { provider, editor, state, window } = liveSite("chatgpt");
    editor.addEventListener("paste", (event) => {
      editor.innerHTML = event.clipboardData.getData("text/plain").split("\n").map((line) => `<p>${line}</p>`).join("");
    }, true);
    editor.addEventListener("paste", (event) => event.stopImmediatePropagation(), true);
    const message = "⟦ZS-SYS⟧\nCONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands";
    document_submit(editor, state);
    await provider.typeAndSend(message, []);
    assert.deepEqual(state.sent, ["⟦ZS-SYS⟧CONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands"]);
    window.close();
  });

  test("a send that does nothing is reported as not confirmed, even though the text sits in the box (it is not 'on the page')", async () => {
    const site = SITES.chatgpt;
    const { window, document } = pageWith(site.html(), site.url);
    const learned = learnProfile({ hostname: site.hostname, name: site.name, picks: site.clicks(document) });
    const provider = createCalibratedProvider({ document, location: window.location, profile: learned.profile, confirmMs: 150 });
    const editor = provider.getEditor();
    let settledAt = 0;
    const nativeFocus = editor.focus.bind(editor);
    editor.focus = () => { settledAt = Date.now(); nativeFocus(); };
    editor.addEventListener("paste", (event) => { if (Date.now() - settledAt >= 100) editor.textContent = event.clipboardData.getData("text/plain"); });
    await assert.rejects(() => provider.typeAndSend("a message the send button ignores", []), /did not confirm the message was sent/);
    window.close();
  });

  test("a site with no send button is sent with Enter", async () => {
    const { document, window, provider: reference } = calibrated(SITES.gemini);
    const learned = learnProfile({
      hostname: "gemini.google.com", name: "Gemini",
      picks: { composer: document.querySelector(".ql-editor"), send: null, assistant: document.querySelector("code-block"), user: document.querySelector(".query-text") },
    });
    assert.deepEqual(learned.profile.send, { enter: true });
    const provider = createCalibratedProvider({ document, location: window.location, profile: learned.profile });
    const editor = provider.getEditor();
    const sent = [];
    let settledAt = 0;
    const nativeFocus = editor.focus.bind(editor);
    editor.focus = () => { settledAt = Date.now(); nativeFocus(); };
    editor.addEventListener("paste", (event) => { if (Date.now() - settledAt >= 100) editor.textContent = event.clipboardData.getData("text/plain"); });
    editor.addEventListener("keydown", (event) => { if (event.key === "Enter") { sent.push(editor.textContent); editor.textContent = ""; } });
    await provider.typeAndSend("sent by Enter", []);
    assert.deepEqual(sent, ["sent by Enter"]);
    assert.ok(reference);
    window.close();
  });

  test("when the paste is ignored the next way in is tried, and the one that worked is remembered", async () => {
    const { provider, editor, state, document, events, window } = liveSite("chatgpt");
    editor.addEventListener("paste", (event) => event.stopImmediatePropagation(), true);
    document.execCommand = (command, _ui, value) => { if (command === "insertText" && Date.now() - state.settledAt >= 100) { editor.textContent = value; return true; } return false; };
    await provider.typeAndSend("second way", []);
    assert.deepEqual(state.sent, ["second way"]);
    assert.ok(events.some(([event, data]) => event === "calibrated.write" && data.via === "insertText"));
    window.close();
  });

  test("a box that takes nothing is an error that says what to do, not a silent empty send", async () => {
    const { provider, editor, state, window } = liveSite("gemini");
    editor.addEventListener("paste", (event) => event.stopImmediatePropagation(), true);
    await assert.rejects(() => provider.typeAndSend("never lands", []), /did not take the typed text/);
    assert.deepEqual(state.sent, []);
    window.close();
  });
});
