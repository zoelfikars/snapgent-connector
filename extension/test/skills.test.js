import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SKILL_MAX_BYTES, parseFrontmatter, parseSkillHeader, skillPath, validateSkillText } from "../src/domain/skills/skill-text.js";
import { SkillsService } from "../src/application/skills-service.js";

const skillText = (name, description, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

describe("skill text", () => {
  test("parses frontmatter, trimming quotes and collapsing whitespace", () => {
    assert.deepEqual(parseFrontmatter('---\nname: "commit-message"\ndescription:   writes   good  commits \n---\nbody'), { name: "commit-message", description: "writes good commits" });
    assert.equal(parseFrontmatter("no frontmatter"), null);
  });

  test("an empty field does not swallow the next line as its value", () => {
    assert.deepEqual(parseFrontmatter("---\nname:\ndescription: d\n---\nx"), { name: "", description: "d" });
  });

  test("CRLF files parse too", () => {
    assert.deepEqual(parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nx"), { name: "a", description: "b" });
  });

  test("a loaded header needs both fields and is trimmed to 200 chars", () => {
    assert.equal(parseSkillHeader(skillText("a", "")), null);
    assert.equal(parseSkillHeader(skillText("", "d")), null);
    assert.equal(parseSkillHeader(skillText("a", "x".repeat(300))).description.length, 200);
  });

  test("validation: every rejection has a specific message", () => {
    const err = (text) => validateSkillText(text).error;
    assert.equal(err(""), "Empty content.");
    assert.equal(err(42), "Empty content.");
    assert.match(err("x".repeat(SKILL_MAX_BYTES + 1)), /Too large/);
    assert.match(err("hello"), /Missing frontmatter/);
    assert.match(err(skillText("Bad Name", "d")), /lowercase letters, digits and hyphens/);
    assert.match(err(skillText("-bad", "d")), /lowercase/);
    assert.match(err(skillText("a".repeat(65), "d")), /max 64/);
    assert.match(err("---\nname: ok\n---\nx"), /description is required/);
    assert.match(err(skillText("ok", "d".repeat(201))), /too long/);
  });

  test("a good skill validates", () => {
    assert.deepEqual(validateSkillText(skillText("commit-message", "Write commits")), { ok: true, name: "commit-message", description: "Write commits" });
  });

  test("skill path", () => assert.equal(skillPath("a"), ".snapgent/skills/a/SKILL.md"));
});

function setup({ files = {}, stored = {}, tools = ["find_files", "read_file", "create_file"] } = {}) {
  const store = { data: { ...stored }, get: async (k) => store.data[k], set: (k, v) => { store.data[k] = v; } };
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === "find_files") return { ok: true, text: JSON.stringify(Object.keys(files)) };
    if (name === "read_file") return files[args.path] === undefined ? { ok: false } : { ok: true, text: files[args.path] };
    if (name === "create_file") { files[args.path] = args.content; return { ok: true }; }
    return { ok: false, error: "nope" };
  };
  const service = new SkillsService({ store, findTool: (n) => (tools.includes(n) ? { name: n } : undefined), callTool });
  return { service, store, calls, files };
}

describe("SkillsService", () => {
  test("loads skills from the workspace and skips unreadable or headerless files", async () => {
    const { service } = setup({ files: { "a/SKILL.md": skillText("alpha", "A"), "b/SKILL.md": "no header", "c/SKILL.md": skillText("gamma", "G") } });
    await service.load();
    assert.deepEqual(service.all.map((s) => [s.name, s.path]), [["alpha", "a/SKILL.md"], ["gamma", "c/SKILL.md"]]);
  });

  test("no find/read tool, or garbage from find, leaves an empty list and never throws", async () => {
    await (async () => { const { service } = setup({ tools: [] }); await service.load(); assert.deepEqual(service.all, []); })();
    const { service } = setup();
    service._callTool = async () => ({ ok: true, text: "{not json" });
    await service.load();
    assert.deepEqual(service.all, []);
  });

  test("at most 30 skills are read", async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}/SKILL.md`, skillText(`s${i}`, "d")]));
    const { service } = setup({ files });
    await service.load();
    assert.equal(service.all.length, 30);
  });

  test("toggles default to enabled, persist, and filter `enabled`", async () => {
    const { service, store } = setup({ files: { "a/SKILL.md": skillText("alpha", "A"), "b/SKILL.md": skillText("beta", "B") } });
    await service.load();
    assert.deepEqual(service.enabled.map((s) => s.name), ["alpha", "beta"]);
    service.setEnabled("beta", false);
    assert.deepEqual(service.enabled.map((s) => s.name), ["alpha"]);
    assert.deepEqual(store.data.zsSkillsEnabled, { beta: false });
  });

  test("persisted toggles and the global library are restored on startup", async () => {
    const { service } = setup({ stored: { zsSkillsEnabled: { beta: false }, zsGlobalSkills: { g: { description: "d", text: "t" } } } });
    await service.ready;
    assert.equal(service.isEnabled("beta"), false);
    assert.equal(service.isEnabled("anything"), true);
    assert.deepEqual(Object.keys(service.globals), ["g"]);
  });

  test("importing writes the file, rejects duplicates, and starts the skill disabled", async () => {
    const { service, files } = setup({ files: { "x/SKILL.md": skillText("existing", "E") } });
    await service.load();
    assert.deepEqual(await service.importText(skillText("fresh", "F")), { ok: true, name: "fresh" });
    assert.ok(files[".snapgent/skills/fresh/SKILL.md"]);
    assert.equal(service.isEnabled("fresh"), false);
    assert.match((await service.importText(skillText("existing", "E"))).error, /already exists/);
    assert.match((await service.importText("bad")).error, /Missing frontmatter/);
  });

  test("import without create_file, and a failed write, report why", async () => {
    const a = setup({ tools: ["find_files", "read_file"] });
    assert.match((await a.service.importText(skillText("x", "y"))).error, /create_file is not available/);
    const b = setup();
    b.service._callTool = async () => ({ ok: false, error: "disk full" });
    assert.equal((await b.service.importText(skillText("x", "y"))).error, "disk full");
  });

  test("global library: save, reject duplicates, remove", async () => {
    const { service, store } = setup();
    assert.deepEqual(service.saveGlobal(skillText("g1", "G")), { ok: true, name: "g1" });
    assert.match(service.saveGlobal(skillText("g1", "G")).error, /already exists/);
    assert.deepEqual(Object.keys(store.data.zsGlobalSkills), ["g1"]);
    service.removeGlobal("g1");
    assert.deepEqual(service.globals, {});
  });
});
