import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

// The extension is a bridge between the chat and the IDE: which model or thinking mode to chat in is the user's choice.
// No adapter may click a model tab or a thinking toggle on its own, at start or afterwards.
describe("DeepSeek: the model tab and the thinking toggle are left to the user", () => {
  const html = `${fixture("sites/deepseek.html")}
<div role="radiogroup">
  <div role="radio" data-model-type="default" aria-checked="true">Instant</div>
  <div role="radio" data-model-type="expert" aria-checked="false">Expert</div>
  <div role="radio" data-model-type="vision" aria-checked="false">Vision</div>
</div>
<div class="ds-toggle-button" aria-pressed="false">DeepThink</div>`;

  function page() {
    const loaded = loadProvider("deepseek.js", html, "https://chat.deepseek.com/a/chat/s/x");
    const clicks = [];
    loaded.document.addEventListener("click", (event) => clicks.push(event.target.textContent.trim()), true);
    return { ...loaded, clicks };
  }

  test("starting on Instant leaves Instant on: Expert and DeepThink are never clicked", async () => {
    const { provider, document, clicks } = page();
    const state = await provider.ensureComposerReady("startup");
    provider.enforceComposer("startup");
    assert.deepEqual(clicks, []);
    assert.equal(document.querySelector('[data-model-type="default"]').getAttribute("aria-checked"), "true");
    assert.equal(document.querySelector('[data-model-type="expert"]').getAttribute("aria-checked"), "false");
    assert.equal(document.querySelector(".ds-toggle-button").getAttribute("aria-pressed"), "false");
    assert.equal(state.ready, true, "and the session can start on the user's choice");
  });

  test("starting on Expert or Vision is equally left as it is", async () => {
    for (const picked of ["expert", "vision"]) {
      const { provider, document, clicks } = page();
      for (const radio of document.querySelectorAll("[role=radio]")) radio.setAttribute("aria-checked", String(radio.dataset.modelType === picked));
      const state = await provider.ensureComposerReady("startup");
      assert.deepEqual(clicks, [], picked);
      assert.equal(state.ready, true, picked);
    }
  });
});
