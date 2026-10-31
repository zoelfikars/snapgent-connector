import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as ZSParse from "../src/domain/parser/index.js";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

// One conversation per site: a user turn carrying the bootstrap marker, an assistant turn whose code
// block holds one tool call, and the composer. The markup is written from each adapter's own selectors
// (no logged-in captures are available), so this guards the adapter LOGIC - counting, reading code out of
// the markup, finding the composer, hiding the block - not drift in the live site. When a site changes,
// replace its file in fixtures/sites/ with a real capture and the same contract applies.
const SITES = [
  { file: "claude.js", stop: { append: '<button data-testid="stop-button">Stop</button>' }, html: "claude.html", url: "https://claude.ai/chat/x" },
  { file: "grok.js", stop: { into: "form", append: '<button aria-label="Stop">Stop</button>' }, html: "grok.html", url: "https://grok.com/chat/x" },
  { file: "mistral.js", stop: { into: "form", append: '<button aria-label="Stop">Stop</button>' }, html: "mistral.html", url: "https://chat.mistral.ai/chat/x" },
  { file: "ptero.js", stop: { classOn: ["#chat-send-btn", "is-stop"] }, html: "ptero.html", url: "https://ptero.pro/" },
  { file: "glm.js", stop: { into: ".messageInputContainer", append: '<button class="rounded-full bg-black"><span></span></button>' }, html: "glm.html", url: "https://chat.z.ai/c/x" },
  { file: "kimi.js", stop: { classOn: [".send-button-container", "stop"] }, html: "kimi.html", url: "https://www.kimi.ai/chat/x" },
  { file: "qwen.js", stop: { into: ".message-input-wrapper", append: '<button class="stop-button">Stop</button>' }, html: "qwen.html", url: "https://chat.qwen.ai/c/x" },
  { file: "deepseek.js", html: "deepseek.html", url: "https://chat.deepseek.com/a/chat/s/x", stop: { into: ".ds-button--primary", append: "<rect></rect>" } },
  { file: "meta.js", html: "meta.html", url: "https://www.meta.ai/prompt/x", stop: { into: "form", append: '<button aria-label="Stop">Stop</button>' } },
  { file: "arena.js", html: "arena.html", url: "https://arena.ai/c/x", stop: { into: "form", append: '<button aria-label="Stop generation">Stop</button>' } },
  { file: "arena.js", name: "arena.js (A/B carousel)", html: "arena-carousel.html", url: "https://arena.ai/c/x", stop: { into: "form", append: '<button aria-label="Stop generation">Stop</button>' } },
  { file: "gemini.js", freshPageLooksBusy: true, stop: { into: "input-area-v2", append: '<button><mat-icon fonticon="stop"></mat-icon></button>' }, html: "gemini.html", url: "https://gemini.google.com/app/x" },
];

for (const site of SITES) {
  describe(`${site.name || site.file} reads a captured conversation`, () => {
    const load = () => loadProvider(site.file, fixture(`sites/${site.html}`), site.url);

    test("counts one user turn and one assistant turn", () => {
      const { provider } = load();
      assert.deepEqual([provider.userCount(), provider.assistantCount()], [1, 1]);
      const items = provider.allItems();
      assert.deepEqual([items.filter(provider.isUserItem).length, items.filter(provider.isAssistantItem).length], [1, 1]);
    });

    test("reads the tool call out of the reply and it parses", () => {
      const { reply } = load().provider.readAssistant();
      const [call] = ZSParse.parseToolCalls(reply);
      assert.equal(call?.tool, "read_file", reply);
      assert.deepEqual(call.arguments, { path: "a.js" });
      assert.ok(!reply.includes("DRAFT"), "a call drafted inside the reasoning must never be read as the reply");
      assert.ok(!reply.includes("TOOLBAR-NOISE"), "page chrome around the reply must not be read as part of it");
    });

    test("the user turn exposes the session marker", () => {
      const { provider } = load();
      const user = provider.allItems().find(provider.isUserItem);
      assert.ok(provider.classifyText(user, ".zs-chip").includes("⟦ZS-SYS⟧"));
    });

    test("finds the composer", () => {
      assert.ok(load().provider.getEditor());
    });

    test("finds a place for the tool chip and hides the raw block", () => {
      const { provider, document } = load();
      assert.ok(provider.findToolBlockSpot(provider.lastAssistant()), "a place to put the chip");
      assert.ok(document.querySelector(".zs-tool-hide"), "the raw call is hidden");
    });

    test("a visible Stop control means it is generating, and it is idle without one", () => {
      const { provider, document } = load();
      // Gemini folds reply growth into this signal, and a freshly loaded page counts as growth.
      if (!site.freshPageLooksBusy) assert.equal(provider.isHardGenerating(), false);
      const { into, append, classOn } = site.stop;
      if (classOn) document.querySelector(classOn[0]).classList.add(classOn[1]);
      else (into ? document.querySelector(into) : document.body).insertAdjacentHTML("beforeend", append);
      assert.equal(provider.isHardGenerating(), true);
    });
  });
}
