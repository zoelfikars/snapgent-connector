// Quick Node smoke test for core/config.js (run: node test-config.js). Not shipped.
const fs = require("fs");
const ZS = new Function(fs.readFileSync(__dirname + "/core/config.js", "utf8") + "; return ZS;")();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const prompt = ZS.buildSystemPrompt({ siteName: "TestAI", targetServer: "vscode", targetName: "VS Code" });
ok("system prompt leads with the session marker", prompt.startsWith(ZS.SYS_MARKER));
ok("system prompt names the target", prompt.includes("VS Code") && prompt.includes('server "vscode"'));
ok("system prompt carries no Roblox leftovers", !/roblox|luau|###LUA/i.test(prompt));

const custom = ZS.buildSystemPrompt({ customPrompt: "Reply in Indonesian", providerNotes: "site note" });
ok("custom prompt appended last", custom.endsWith("Reply in Indonesian"));
ok("provider notes included", custom.includes("site note"));

const skilled = ZS.buildSystemPrompt({ skills: [{ name: "commit", description: "write commits" }] });
ok("skills listed", skilled.includes("- commit: write commits"));

ok("read tool category", ZS.toolCategory("read_file") === "read" && ZS.toolCategory("git_status") === "read");
ok("edit tool category", ZS.toolCategory("edit_file") === "edit" && ZS.toolCategory("vscode/git_commit") === "edit");
ok("other tool category", ZS.toolCategory("run_command") === "tool");
ok("parse-error falls back to malformed", ZS.FEEDBACK.parseError("nope").includes("could not be parsed"));
