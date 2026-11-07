import { test } from "node:test";
import assert from "node:assert/strict";
import * as ZS from "../src/domain/index.js";
import { cleanContext } from "../src/domain/prompt/context-file.js";

const workspace = { name: "snapgent-connector", path: "/home/me/snapgent-connector", git: true };
const prompt = ZS.buildSystemPrompt({ workspace, targetName: "VS Code" });
test("the prompt opens with the project, in plain words and with no tag", () => assert.ok(prompt.startsWith("snapgent-connector is your current workspace.")));
test("the prompt says where the project is and that it is a git repository", () => assert.ok(prompt.includes("/home/me/snapgent-connector and it is a git repository")));
test("without a known workspace it speaks of this folder", () => assert.ok(ZS.buildSystemPrompt().startsWith("This folder is your current workspace.")));
test("the prompt names the target", () => assert.ok(prompt.includes("VS Code")));
test("the prompt looks like nothing a bot or a system tag would say", () => assert.ok(!/CONTEXT:|ZS-SYS|snapgentV3|extension|━━━|SYSTEM/.test(prompt)));
test("system prompt carries no Roblox leftovers", () => assert.ok(!/roblox|luau|###LUA/i.test(prompt)));

const custom = ZS.buildSystemPrompt({ customPrompt: "Reply in Indonesian", providerNotes: "site note" });
test("custom prompt appended last", () => assert.ok(custom.endsWith("Reply in Indonesian")));
test("provider notes included", () => assert.ok(custom.includes("site note")));

const start = ZS.buildStartMessage({ prompt: "P", commands: "snapgent commands (2):\n\nread_files(...)", tree: "root\n└── a.js" });
test("the start message holds the prompt, the commands and the tree, and asks for a short answer", () => {
  assert.ok(start.startsWith("P\n\n") && start.includes("read_files(...)") && start.includes("└── a.js"));
  assert.ok(start.endsWith("I will tell you what I want to do."));
  assert.match(start, /reply "understood"/);
});
test("a start message without a tree leaves that part out", () => assert.ok(!ZS.buildStartMessage({ prompt: "P", commands: "c" }).includes("project looks like")));
const withContext = ZS.buildStartMessage({ prompt: "P", commands: "c", context: { name: "AGENTS.md", text: "use pnpm" } });
test("a found instruction file goes into the start message, before the commands", () => {
  assert.ok(withContext.includes("Project instructions from AGENTS.md:\n\nuse pnpm"));
  assert.ok(withContext.indexOf("use pnpm") < withContext.indexOf("These are the commands"));
});
test("without one, the start message says nothing about project instructions", () => assert.ok(!ZS.buildStartMessage({ prompt: "P", commands: "c" }).includes("Project instructions")));

const skilled = ZS.buildSystemPrompt({ skills: [{ name: "commit", description: "write commits" }] });
test("skills listed", () => assert.ok(skilled.includes("- commit: write commits")));

const clean = (text) => cleanContext(text);
test("a file reference in an instruction file stays a plain path, without its @", () => {
  assert.equal(clean("see @docs/ARCHITECTURE.md and @./a.md, also @src/"), "see docs/ARCHITECTURE.md and ./a.md, also src/");
});
test("an @ that is not a path is still defused, an address is left alone", () => {
  assert.equal(clean("@import rules\nmail a@b.com, ask @john."), "[at]import rules\nmail a@b.com, ask [at]john.");
});
test("the read_files wrapping is removed", () => assert.equal(clean("===== AGENTS.md =====\n1: use pnpm\n2: @docs/x.md"), "use pnpm\ndocs/x.md"));

test("parse-error falls back to malformed", () => assert.ok(ZS.FEEDBACK.parseError("nope").includes("could not be parsed")));

test("the prompt tells the model the effective Commands per reply when given", () => {
  assert.ok(ZS.buildSystemPrompt({ calls: 5 }).includes("at most 5 commands"));
  assert.ok(ZS.buildSystemPrompt({ calls: 1 }).includes("at most 1 command in one reply"));
  assert.ok(!ZS.buildSystemPrompt({ calls: 1 }).includes("at most 1 commands"));
});
test("without a Commands per reply value the prompt keeps the old several wording", () => assert.ok(ZS.buildSystemPrompt().includes("several commands")));
test("an unusable Commands per reply value falls back to several", () => assert.ok(ZS.buildSystemPrompt({ calls: 0 }).includes("several commands")));
