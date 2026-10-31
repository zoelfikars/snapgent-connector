import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as ZSParse from "../src/domain/parser/index.js";
import { CHATGPT_LAYOUTS, pickLayout, layoutOf } from "../src/infrastructure/chat/chatgpt-layouts.js";
import { describeAnchor } from "../src/infrastructure/chat/dom-diagnostics.js";
import { fixture, loadProvider } from "./support/jsdom-provider.js";

const ASSISTANT_ID = "3e43dbf8-d16e-4597-bd42-ea94013e9851";

describe("ChatGPT adapter on the 2026-10 page layout (captured markup)", () => {
  const load = () => loadProvider("chatgpt.js", fixture("chatgpt-search-units-2026-10.html"));

  test("sees one user turn and one assistant turn", () => {
    const { provider } = load();
    assert.equal(provider.userCount(), 1);
    assert.equal(provider.assistantCount(), 1);
    assert.equal(provider.allItems().length, 2);
  });

  test("identifies the last assistant turn by its message UUID", () => {
    assert.equal(load().provider.lastAssistantId(), ASSISTANT_ID);
  });

  test("reads the model's command out of the code block, and it parses", () => {
    const { reply, item } = load().provider.readAssistant();
    assert.ok(item);
    assert.match(reply, /"command":"list_commands"/);
    const [call] = ZSParse.parseToolCalls(reply);
    assert.deepEqual(call, { tool: "list_commands", arguments: { server: "vscode" } });
  });

  test("the user turn carries the session marker, so the bootstrap can be camouflaged", () => {
    const { provider } = load();
    const user = provider.allItems().find(provider.isUserItem);
    assert.ok(provider.classifyText(user, ".zs-chip").includes("⟦ZS-SYS⟧"));
  });

  test("the whole code block (header and copy button included) is hidden, not just the <pre>", () => {
    const { provider, document } = load();
    const spot = provider.findToolBlockSpot(provider.lastAssistant());
    assert.ok(spot, "a place to put the chip");
    assert.ok(document.querySelector('[data-code-block="true"]').classList.contains("zs-tool-hide"));
  });

  test("reports which layout it recognised", () => {
    assert.equal(load().provider.describeLayout(), "search-units-2026-10");
  });
});

describe("ChatGPT adapter on the classic layout (must keep working)", () => {
  const load = () => loadProvider("chatgpt.js", fixture("chatgpt-classic.html"));

  test("counts, ids and reply", () => {
    const { provider } = load();
    assert.deepEqual([provider.userCount(), provider.assistantCount(), provider.lastAssistantId()], [1, 1, "a-1"]);
    assert.deepEqual(ZSParse.parseToolCalls(provider.readAssistant().reply)[0].tool, "read_file");
    assert.equal(provider.describeLayout(), "classic");
  });
});

describe("ChatGPT adapter on the DilResponseRoot layout", () => {
  test("a reply without role or id attributes is still an assistant turn and its command parses", () => {
    const { provider } = loadProvider("chatgpt.js", fixture("chatgpt-classic-dil.html"));
    assert.equal(provider.assistantCount(), 1);
    const [call] = ZSParse.parseToolCalls(provider.readAssistant().reply);
    assert.deepEqual(call, { tool: "list_commands", arguments: { server: "vscode" } });
  });
});

describe("ChatGPT adapter on an unrecognised page", () => {
  test("sees nothing and says so, instead of guessing", () => {
    const { provider } = loadProvider("chatgpt.js", "<html><body><div><p>hello</p></div></body></html>");
    assert.deepEqual([provider.userCount(), provider.assistantCount(), provider.describeLayout()], [0, 0, null]);
    assert.equal(provider.readAssistant().item, null);
  });
});

describe("layout selection", () => {
  test("every layout is named uniquely", () => {
    assert.equal(new Set(CHATGPT_LAYOUTS.map((l) => l.name)).size, CHATGPT_LAYOUTS.length);
  });

  test("pickLayout and layoutOf agree", () => {
    const { document } = loadProvider("chatgpt.js", fixture("chatgpt-search-units-2026-10.html"));
    const layout = pickLayout(document);
    assert.equal(layout.name, "search-units-2026-10");
    assert.equal(layoutOf(document.querySelector(layout.turns)), layout);
    assert.equal(layout.role(document.querySelector(layout.turns)), "user");
  });
});

describe("describeAnchor", () => {
  test("prints the ancestor chain of the last occurrence of a text, innermost first", () => {
    const { document } = loadProvider("chatgpt.js", fixture("chatgpt-search-units-2026-10.html"));
    const chain = describeAnchor(document, "list_commands");
    assert.match(chain[0], /^span/);
    assert.ok(chain.some((line) => line.includes('data-markdown-text-style="assistant-message"')));
    assert.ok(chain.some((line) => line.includes('data-content-search-unit-key="fallback-turn-1:1:assistant"')));
  });

  test("empty when the text is not on the page; depth is bounded", () => {
    const { document } = loadProvider("chatgpt.js", fixture("chatgpt-classic.html"));
    assert.deepEqual(describeAnchor(document, "not here"), []);
    assert.ok(describeAnchor(document, "read_file", 2).length <= 2);
  });
});
