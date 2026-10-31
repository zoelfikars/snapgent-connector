import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCalibratedProvider, learnProfile, updateProfile, profileProblems } from "../src/infrastructure/calibration/index.js";
import { createCalibrationWizard } from "../src/ui/calibration-wizard.js";
import { waitFor } from "../src/infrastructure/chat/wait.js";
import { pageWith } from "./support/jsdom-provider.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PAGE = fixture("chatgpt-search-units-2026-10.html").replace("</main>", `</main><form><div id="prompt-textarea" contenteditable="true" role="textbox"><p id="line"></p></div><button data-testid="send-button" aria-label="Send prompt"><span id="icon"></span></button></form>`);

function setup({ current = null, saveResult = { ok: true } } = {}) {
  const { window, document } = pageWith(PAGE, "https://chatgpt.com/c/test");
  const saved = [];
  const closed = [];
  const copied = [];
  // The text box behaves like a rich editor: it takes a paste once its caret has settled, and delete empties it.
  const editor = document.getElementById("prompt-textarea");
  const state = { settledAt: 0, takesText: true };
  const nativeFocus = editor.focus.bind(editor);
  editor.focus = () => { state.settledAt = Date.now(); nativeFocus(); };
  editor.addEventListener("paste", (event) => { if (state.takesText && Date.now() - state.settledAt >= 100) editor.textContent = event.clipboardData.getData("text/plain"); });
  document.execCommand = (command) => { if (command === "delete") { editor.textContent = ""; return true; } return false; };
  const wizard = createCalibrationWizard({
    document, hostname: "chatgpt.com", name: "ChatGPT", current,
    calibration: { learnProfile, updateProfile, createProvider: (profile) => createCalibratedProvider({ document, location: window.location, profile }) },
    onSave: async (profile) => { saved.push(profile); return saveResult; }, onClose: () => closed.push(true), shadowMode: "open", trusted: () => true,
    describe: (el) => `${el.localName}${el.id ? `#${el.id}` : ""}`, copy: async (text) => { copied.push(text); },
  });
  const click = (el) => {
    el.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const panel = () => wizard.panel();
  const press = (action) => panel().querySelector(`[data-action="${action}"]`).click();
  const text = () => panel().querySelector(".text").textContent;
  const errorText = () => (panel().querySelector(".error").hidden ? "" : panel().querySelector(".error").textContent);
  const q = (selector) => document.querySelector(selector);
  const walkToPreview = () => {
    click(q("#line"));                       // inside the text box: the box itself is chosen
    click(q("#icon"));                       // inside the button: the button is chosen
    click(q("pre"));                         // a reply
    click(q(".whitespace-pre-wrap"));        // my own message
  };
  return { window, document, wizard, saved, closed, copied, click, panel, press, text, errorText, q, state, walkToPreview, editor };
}

describe("calibration wizard", () => {
  test("four clicks, a preview of what will be read, a text-box check and a save: the profile it saves reads the page", async () => {
    const t = setup();
    t.wizard.start();
    assert.match(t.text(), /text box/i);
    t.walkToPreview();
    assert.equal(t.wizard.state().step, "preview");
    assert.match(t.panel().querySelector("pre").textContent, /"command"/, "the preview shows the reply text");
    t.press("looks-right");
    assert.ok(await waitFor(() => t.wizard.state().done, 5000), "saved");
    assert.equal(t.saved.length, 1);
    const profile = t.saved[0];
    assert.deepEqual(profileProblems(profile), []);
    assert.equal(t.editor.textContent, "", "the test text was removed from the box");
    const provider = createCalibratedProvider({ document: t.document, location: t.window.location, profile });
    assert.deepEqual([provider.userCount(), provider.assistantCount()], [1, 1]);
    assert.match(provider.readAssistant().reply, /"command"/);
    assert.match(t.text(), /Open a new chat/, "Start is only offered in a new chat, so it says so");
    t.press("close");
    assert.equal(t.panel(), null, "the panel is gone");
    assert.equal(t.closed.length, 1);
  });

  test("the preview lists every turn it found, labelled, so a swapped or missed one is visible before saving", () => {
    const t = setup();
    t.wizard.start();
    t.walkToPreview();
    const preview = t.panel().querySelector("pre").textContent;
    assert.match(preview, /Found 1 message\(s\) of yours and 1 AI reply\(ies\)/);
    assert.match(preview, /You: ⟦ZS-SYS⟧/);
    assert.match(preview, /AI : .*command/);
    assert.match(preview, /Last AI reply, as it will be read:/);
  });

  test("what was clicked stays on the page with a label, until it is redone or the dialog closes", () => {
    const t = setup();
    t.wizard.start();
    const marks = () => [...t.panel().querySelectorAll(".mark span")].map((span) => span.textContent);
    t.click(t.q("#line"));
    assert.deepEqual(marks(), ["1 · Text box"]);
    t.click(t.q("#icon"));
    t.click(t.q("pre"));
    t.click(t.q(".whitespace-pre-wrap"));
    assert.deepEqual(marks(), ["1 · Text box", "2 · Send button", "3 · AI reply", "4 · Your message"]);
    t.press("redo-reply");
    assert.deepEqual(marks(), ["1 · Text box", "2 · Send button"], "the reply and message marks go with the redo");
    t.wizard.cancel();
    assert.equal(t.panel(), null);
  });

  test("the instructions say what to click: the words, not a button or the space around", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("#line"));
    t.click(t.q("#icon"));
    assert.match(t.text(), /WORDS of a reply written by the AI/);
    t.click(t.q("pre"));
    assert.match(t.text(), /WORDS of a message that YOU sent/);
  });

  test("nothing is sent while calibrating: only the test text is written and then cleared", async () => {
    const t = setup();
    const sent = [];
    t.q('[data-testid="send-button"]').addEventListener("click", () => sent.push("send"));
    t.wizard.start();
    t.walkToPreview();
    t.press("looks-right");
    await waitFor(() => t.wizard.state().done, 5000);
    assert.deepEqual(sent, [], "the send button was only described, never pressed (the picker swallowed the click)");
  });

  test("a click that is not a text box is refused with a reason and the step stays", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("main"));
    assert.match(t.errorText(), /does not look like a text box/);
    assert.equal(t.wizard.state().step, "composer");
  });

  test("my own message must not be part of the reply", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("#line"));
    t.click(t.q("#icon"));
    t.click(t.q("pre"));
    t.click(t.q("[data-markdown-text-style]"));
    assert.match(t.errorText(), /part of the reply/);
    assert.equal(t.wizard.state().step, "message");
  });

  test("a site with no send button: 'Enter sends' replaces the click", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("#line"));
    assert.ok(t.panel().querySelector('[data-action="enter-sends"]'));
    t.press("enter-sends");
    t.click(t.q("pre"));
    t.click(t.q(".whitespace-pre-wrap"));
    assert.equal(t.wizard.state().step, "preview");
    t.press("looks-right");
    return waitFor(() => t.wizard.state().done, 5000).then(() => assert.deepEqual(t.saved[0].send, { enter: true }));
  });

  test("when the preview shows the wrong part, the user points at the answer and sees the new preview", () => {
    const t = setup();
    t.wizard.start();
    t.walkToPreview();
    t.press("pick-answer");
    assert.match(t.text(), /answer/i);
    t.click(t.q("[data-markdown-text-style]"));
    assert.equal(t.wizard.state().step, "preview");
    assert.match(t.panel().querySelector("pre").textContent, /"command"/);
  });

  test("redoing the reply from the preview goes back to the reply step", () => {
    const t = setup();
    t.wizard.start();
    t.walkToPreview();
    t.press("redo-reply");
    assert.equal(t.wizard.state().step, "reply");
  });

  test("a part of the reply with nothing readable in it is flagged in the preview, and 'Looks right' is not the highlighted choice", () => {
    const t = setup();
    t.q("[data-markdown-text-style]").insertAdjacentHTML("afterbegin", '<i class="empty-part" data-part="none"></i>');
    t.wizard.start();
    t.walkToPreview();
    t.press("pick-answer");
    t.click(t.q(".empty-part"));
    assert.equal(t.wizard.state().step, "preview");
    assert.match(t.errorText(), /Nothing was read/);
    assert.equal(t.panel().querySelector('[data-action="looks-right"]').className, "", "not the primary button");
  });

  test("Back goes to the previous step; Escape and Cancel close everything and give the page its clicks back", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("#line"));
    t.press("back");
    assert.equal(t.wizard.state().step, "composer");
    t.document.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(t.wizard.state().open, false);
    assert.equal(t.closed.length, 1);
    const reached = [];
    t.q('[data-testid="send-button"]').addEventListener("click", () => reached.push(1));
    t.click(t.q('[data-testid="send-button"]'));
    assert.deepEqual(reached, [1]);
  });

  test("a text box that takes nothing is reported, and the user can redo it or save anyway", async () => {
    const t = setup();
    t.state.takesText = false;
    t.wizard.start();
    t.walkToPreview();
    t.press("looks-right");
    assert.ok(await waitFor(() => t.errorText().includes("did not take the test text"), 20000)); // three ways in, each given a few seconds
    assert.equal(t.saved.length, 0, "not saved yet");
    assert.ok(t.panel().querySelector('[data-action="redo-composer"]') && t.panel().querySelector('[data-action="save"]'));
  });

  test("a save that fails says so and can be tried again", async () => {
    const t = setup({ saveResult: { ok: false, error: "Storage is full." } });
    t.wizard.start();
    t.walkToPreview();
    t.press("looks-right");
    assert.ok(await waitFor(() => t.errorText() === "Storage is full.", 5000));
    assert.ok(t.panel().querySelector('[data-action="save"]'));
    assert.equal(t.wizard.state().done, false);
  });

  test("a reply and a message that cannot be told apart send the user back to the reply step with the reason", () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("#line"));
    t.click(t.q("#icon"));
    t.click(t.q("pre"));
    t.click(t.q("pre code")); // inside the same reply (different element, same turn): refused earlier as part of the reply
    assert.match(t.errorText(), /part of the reply/);
  });

  test("redoing just one part keeps the rest of the profile", async () => {
    const first = setup();
    first.wizard.start();
    first.walkToPreview();
    first.press("looks-right");
    await waitFor(() => first.wizard.state().done, 5000);
    const existing = first.saved[0];
    const t = setup({ current: existing });
    t.wizard.start({ only: "send" });
    assert.match(t.text(), /send button/i);
    assert.equal(t.panel().querySelector(".step").textContent, "", "a single step has no counter");
    t.press("enter-sends");
    await waitFor(() => t.wizard.state().done, 5000);
    assert.deepEqual(t.saved[0].send, { enter: true });
    assert.deepEqual(t.saved[0].assistant, existing.assistant, "the reply part is as it was");
    assert.deepEqual(t.saved[0].composer, existing.composer);
  });

  test("redoing the reply asks for a reply and a message, shows the preview, and keeps the text box and button", async () => {
    const first = setup();
    first.wizard.start();
    first.walkToPreview();
    first.press("looks-right");
    await waitFor(() => first.wizard.state().done, 5000);
    const existing = first.saved[0];
    const t = setup({ current: existing });
    t.wizard.start({ only: "reply" });
    t.click(t.q("pre"));
    t.click(t.q(".whitespace-pre-wrap"));
    assert.equal(t.wizard.state().step, "preview");
    t.press("looks-right");
    await waitFor(() => t.wizard.state().done, 5000);
    assert.deepEqual(t.saved[0].composer, existing.composer);
    assert.deepEqual(t.saved[0].send, existing.send);
  });

  test("a report can be copied when something is wrong or at the preview: where the clicks landed and the profile, never the conversation", async () => {
    const t = setup();
    t.wizard.start();
    t.click(t.q("main"));                                   // not a text box: an error
    t.panel().querySelector('[data-action="copy-report"]').click();
    await waitFor(() => t.copied.length === 1, 2000);
    assert.match(t.copied[0], /site: chatgpt.com \(ChatGPT\)/);
    assert.match(t.copied[0], /error: That does not look like a text box/);
  });

  test("the preview offers the report too, with the learned profile and the clicked elements, and none of the text", async () => {
    const t = setup();
    t.wizard.start();
    t.walkToPreview();
    t.panel().querySelector('[data-action="copy-report"]').click();
    await waitFor(() => t.copied.length === 1, 2000);
    const report = t.copied[0];
    assert.match(report, /profile: \{"version":1/);
    assert.match(report, /composer:\n\s+div#prompt-textarea/);
    assert.doesNotMatch(report, /list_commands|⟦ZS-SYS⟧|CONTEXT:/, "no conversation text");
  });

  test("a failed copy says so instead of pretending", async () => {
    const { window, document } = pageWith("<body><div contenteditable='true' id='box'></div></body>");
    const wizard = createCalibrationWizard({
      document, hostname: "a.test", name: "A", current: null, calibration: { learnProfile, updateProfile, createProvider: () => ({}) },
      onSave: async () => ({ ok: true }), trusted: () => true, shadowMode: "open", copy: async () => { throw new Error("denied"); },
    });
    wizard.start();
    document.body.insertAdjacentHTML("beforeend", "<p id='plain'>x</p>");
    document.getElementById("plain").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    wizard.panel().querySelector('[data-action="copy-report"]').click();
    assert.ok(await waitFor(() => /Could not copy/.test(wizard.panel().querySelector(".hint").textContent), 2000));
  });

  test("the panel cannot be reached from the page (closed shadow root by default)", () => {
    const { window, document } = pageWith("<body><p id='x'></p></body>");
    const wizard = createCalibrationWizard({
      document, hostname: "a.test", name: "A", current: null, calibration: { learnProfile, updateProfile, createProvider: () => ({}) },
      onSave: async () => ({ ok: true }), trusted: () => true,
    });
    wizard.start();
    assert.equal(document.getElementById("zs-calibrate").shadowRoot, null);
    assert.ok(window);
    wizard.cancel();
  });

  test("a click a page script fabricated moves nothing forward", () => {
    const { window, document } = pageWith("<body><div contenteditable='true' id='box'></div></body>");
    const wizard = createCalibrationWizard({
      document, hostname: "a.test", name: "A", current: null, calibration: { learnProfile, updateProfile, createProvider: () => ({}) },
      onSave: async () => ({ ok: true }), // default trust: a dispatched event is never isTrusted
    });
    wizard.start();
    document.getElementById("box").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(wizard.state().step, "composer");
    wizard.cancel();
  });
});
