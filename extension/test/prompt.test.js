import { test } from "node:test";
import assert from "node:assert/strict";
import * as ZS from "../src/domain/index.js";

const prompt = ZS.buildSystemPrompt({ siteName: "TestAI", targetServer: "vscode", targetName: "VS Code" });
test("system prompt leads with the session marker", () => assert.ok(prompt.startsWith(ZS.SYS_MARKER)));
test("system prompt names the target", () => assert.ok(prompt.includes("VS Code") && prompt.includes('server "vscode"')));
test("system prompt carries no Roblox leftovers", () => assert.ok(!/roblox|luau|###LUA/i.test(prompt)));

const custom = ZS.buildSystemPrompt({ customPrompt: "Reply in Indonesian", providerNotes: "site note" });
test("custom prompt appended last", () => assert.ok(custom.endsWith("Reply in Indonesian")));
test("provider notes included", () => assert.ok(custom.includes("site note")));

const skilled = ZS.buildSystemPrompt({ skills: [{ name: "commit", description: "write commits" }] });
test("skills listed", () => assert.ok(skilled.includes("- commit: write commits")));

test("read tool category", () => assert.ok(ZS.toolCategory("read_file") === "read" && ZS.toolCategory("git_status") === "read"));
test("edit tool category", () => assert.ok(ZS.toolCategory("edit_file") === "edit" && ZS.toolCategory("vscode/git_commit") === "edit"));
test("other tool category", () => assert.ok(ZS.toolCategory("run_command") === "tool"));
test("parse-error falls back to malformed", () => assert.ok(ZS.FEEDBACK.parseError("nope").includes("could not be parsed")));
