import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { imageNames, parseInline, parseTutorial } from "../src/domain/tutorial/parse.js";
import { openTutorial } from "../src/ui/tutorial-popup.js";
import { tutorialModuleSource } from "../build/tutorial.mjs";

const MD = "# Title\n\nHello **world** and `code`\nsecond line\n\n- a\n- b\n\n@gambar(one.png)\n\n```\n@gambar(no.png)\n```\n";

describe("tutorial parser", () => {
  test("reads headings, paragraphs, lists, images and fenced code", () => {
    const blocks = parseTutorial(MD);
    assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "list", "image", "code"]);
    assert.equal(blocks[1].text, "Hello **world** and `code` second line");
    assert.deepEqual(blocks[2].items, ["a", "b"]);
    assert.equal(blocks[3].name, "one.png");
    assert.equal(blocks[4].text, "@gambar(no.png)");
  });

  test("only images outside a code fence count, each once", () => {
    assert.deepEqual(imageNames(`${MD}\n@gambar(one.png)\n@gambar( two.jpg )\n`), ["one.png", "two.jpg"]);
  });

  test("inline pieces", () => {
    assert.deepEqual(parseInline("a **b** `c`"), [{ t: "text", v: "a " }, { t: "b", v: "b" }, { t: "text", v: " " }, { t: "code", v: "c" }]);
  });
});

describe("tutorial popup", () => {
  const open = (markdown, images) => {
    const w = new JSDOM("<!doctype html><body></body>").window;
    openTutorial({ document: w.document, markdown, images });
    return w.document;
  };

  test("draws the blocks, with the image from the embedded set", () => {
    const doc = open(MD, { "one.png": "data:image/png;base64,AAAA" });
    assert.equal(doc.querySelector("h3").textContent, "Title");
    assert.equal(doc.querySelector("b").textContent, "world");
    assert.equal(doc.querySelectorAll("li").length, 2);
    assert.equal(doc.querySelector("img").getAttribute("src"), "data:image/png;base64,AAAA");
  });

  test("text never becomes markup and only embedded images are shown", () => {
    const doc = open("<i>x</i>\n\n@gambar(a.png)", { "a.png": "javascript:alert(1)" });
    assert.equal(doc.querySelector("i"), null);
    assert.equal(doc.querySelector("img"), null);
    assert.match(doc.querySelector(".zs-tut").textContent, /<i>x<\/i>[\s\S]*image missing: a\.png/);
  });

  test("an empty tutorial says so, and the X closes it", () => {
    const doc = open("", {});
    assert.match(doc.querySelector(".zs-tut").textContent, /No tutorial has been written yet/);
    doc.querySelector(".zs-mcp-pop-close").click();
    assert.equal(doc.getElementById("zs-mcp-pop"), null);
  });
});

describe("tutorial build module", () => {
  async function project(markdown, images = {}) {
    const root = await mkdtemp(join(tmpdir(), "tutorial-"));
    await mkdir(join(root, "tutorial", "images"), { recursive: true });
    if (markdown !== null) await writeFile(join(root, "tutorial", "tutorial.md"), markdown);
    for (const [name, bytes] of Object.entries(images)) await writeFile(join(root, "tutorial", "images", name), bytes);
    return root;
  }

  test("embeds the images the text names as data URIs", async () => {
    const root = await project("Hi\n\n@gambar(a.png)\n", { "a.png": Buffer.from([1, 2, 3]), "unused.png": Buffer.from([9]) });
    try {
      const source = await tutorialModuleSource(root);
      assert.match(source, /"a\.png":"data:image\/png;base64,AQID"/);
      assert.doesNotMatch(source, /unused/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a missing image or an unsafe name stops the build with a clear message", async () => {
    const missing = await project("@gambar(nope.png)");
    const unsafe = await project("@gambar(../x.png)");
    try {
      await assert.rejects(tutorialModuleSource(missing), /@gambar\(nope\.png\) not found/);
      await assert.rejects(tutorialModuleSource(unsafe), /plain file name/);
    } finally {
      await rm(missing, { recursive: true, force: true });
      await rm(unsafe, { recursive: true, force: true });
    }
  });

  test("no tutorial file gives an empty tutorial", async () => {
    const root = await project(null);
    try {
      assert.match(await tutorialModuleSource(root), /TUTORIAL_MARKDOWN = ""/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
