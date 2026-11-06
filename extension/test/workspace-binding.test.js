import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceBinding } from "../src/page/workspace-binding.js";
import { chooseWorkspace } from "../src/application/workspace-choice.js";
import { withoutReserved, ROOT_ARGUMENT } from "../src/domain/tools/confirmation.js";
import { createChoiceDialog } from "../src/ui/choice-dialog.js";
import { computeBarView } from "../src/ui/bar-view.js";
import { pageWith } from "./support/jsdom-provider.js";

function store(initial) {
  const data = { ...(initial ? { zsWorkspaceRoots: initial } : {}) };
  return { data, get: async (key) => data[key], set: (key, value) => { data[key] = value; } };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the folder a chat works in", () => {
  test("a folder chosen at the start is kept under the chat's id once it has one, and is read back per chat", async () => {
    const storage = store();
    const provider = { key: "", conversationKey() { return this.key; } };
    const binding = createWorkspaceBinding({ storage, provider });
    binding.setPending("/work/portofolio");
    assert.equal(binding.current(), "/work/portofolio", "before the chat has an id the pending choice is used");
    binding.commit();
    assert.equal(binding.current(), "/work/portofolio", "no id yet: still pending");
    provider.key = "/c/AAA";
    binding.commit();
    assert.deepEqual(storage.data.zsWorkspaceRoots, { "/c/AAA": "/work/portofolio" });
    provider.key = "/c/BBB";
    assert.equal(binding.current(), null, "another chat does not inherit it");
    binding.setPending("/work/snapgent");
    binding.commit();
    provider.key = "/c/AAA";
    assert.equal(binding.current(), "/work/portofolio", "back in the first chat: its own folder");
  });

  test("the folder is kept per login: the same chat URL under another account does not inherit it", async () => {
    const storage = store();
    const provider = { conversationKey: () => "/chat/abc" };
    let account = "work";
    const binding = createWorkspaceBinding({ storage, provider, accountKey: () => account });
    binding.bind("/work/portofolio");
    assert.equal(binding.current(), "/work/portofolio");
    account = "home";
    assert.equal(binding.current(), null, "another login's chat has no folder yet");
    binding.bind("/work/home-project");
    account = "work";
    assert.equal(binding.current(), "/work/portofolio", "each login keeps its own folder");
    account = "";
    assert.equal(binding.current(), null, "with no account the plain chat key is used, and it is empty");
  });

  test("it survives a reload: a new instance reads what was stored", async () => {
    const provider = { conversationKey: () => "/c/AAA" };
    const binding = createWorkspaceBinding({ storage: store({ "/c/AAA": "/work/portofolio" }), provider });
    await settled();
    assert.equal(binding.current(), "/work/portofolio");
  });

  test("choosing a folder in the bar rebinds the chat; Auto lets it follow the server again", () => {
    const storage = store();
    const binding = createWorkspaceBinding({ storage, provider: { conversationKey: () => "/c/AAA" } });
    binding.bind("/work/a");
    assert.equal(binding.current(), "/work/a");
    binding.bind(null);
    assert.equal(binding.current(), null);
    assert.deepEqual(storage.data.zsWorkspaceRoots, {});
  });

  test("the model cannot name the folder itself", () => {
    assert.deepEqual(withoutReserved({ path: "a", [ROOT_ARGUMENT]: "/etc" }), { path: "a" });
  });
});

describe("which folder a new chat starts in", () => {
  const ask = (answer) => async (open) => { ask.seen = open; return answer; };
  test("the pinned folder is the default and nobody is asked", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, pinned: "/p", open: ["/a", "/b"] }, ask("/a")), { path: "/p" });
    assert.equal(ask.seen, undefined);
  });
  test("one open folder is used as it is", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, open: ["/a"] }, ask(null)), { path: "/a" });
  });
  test("two open windows: the user is asked, and the answer is the folder", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, open: ["/a", "/b"] }, ask("/b")), { path: "/b" });
    assert.deepEqual(ask.seen, ["/a", "/b"]);
  });
  test("closing the question cancels the start", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, open: ["/a", "/b"] }, ask(null)), { cancelled: true });
  });
  test("VS Code not open at all, and a bridge that cannot be reached, are told apart", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, open: [] }, ask(null)), { none: true });
    assert.deepEqual(await chooseWorkspace({ ok: false, error: "down" }, ask(null)), { error: "down" });
  });
  test("with no editor open the folders used lately are offered, after the open ones", async () => {
    assert.deepEqual(await chooseWorkspace({ ok: true, open: [], recent: ["/r1", "/r2"] }, ask("/r2")), { path: "/r2" });
    assert.deepEqual(ask.seen, ["/r1", "/r2"]);
    assert.deepEqual(await chooseWorkspace({ ok: true, open: ["/a", "/b"], recent: ["/a", "/r1"] }, ask("/r1")), { path: "/r1" });
    assert.deepEqual(ask.seen, ["/a", "/b", "/r1"], "a folder already open is not listed twice");
  });
});

describe("the folder question", () => {
  async function open(options) {
    const { document, window } = pageWith("<body></body>", "https://chat.test/");
    const dialog = createChoiceDialog({ document, shadowMode: "open", isTrusted: (event) => event.detail === 1 });
    const answer = dialog.choose({ title: "Which?", options });
    await settled(); // the dialog is built a tick after the question is asked
    const shadow = document.documentElement.lastElementChild.shadowRoot;
    return { answer, shadow, window };
  }
  test("lists each folder by name with its path, and a real click answers with that path", async () => {
    const { answer, shadow, window } = await open(["/work/portofolio", "/work/snapgent-connector"]);
    const buttons = [...shadow.querySelectorAll(".opt")];
    assert.deepEqual(buttons.map((b) => b.querySelector(".name").textContent), ["portofolio", "snapgent-connector"]);
    buttons[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(await answer, "/work/snapgent-connector");
  });
  test("a click the page made up is ignored, and Cancel means no choice", async () => {
    const { answer, shadow, window } = await open(["/a", "/b"]);
    shadow.querySelector(".opt").dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 0 }));
    shadow.querySelector(".cancel").click();
    assert.equal(await answer, null);
  });
});

describe("a chat whose folder is not open because VS Code is closed", () => {
  const base = { staleExtension: false, starting: false, started: true, running: false, parked: false, blankChat: false, bridge: { connected: true, servers: [{ id: "snapgent", alive: true, tools: 0 }] }, bridgeOk: false, target: { id: "snapgent", name: "Snapgent MCP" }, activeToolCount: 0, workspaceReady: false, workspaceProbePending: false, modeWarning: null };
  test("the bar names the folder to open", () => {
    const v = computeBarView({ ...base, workspaceFolder: "/home/me/Projects/portofolio" });
    assert.equal(v.message, "<b>Active</b> · open <b>portofolio</b> in your editor");
    assert.equal(v.warn, true);
  });
  test("with no known folder it says what it said before", () => {
    assert.match(computeBarView({ ...base, workspaceFolder: null }).message, /offline/);
  });
});
