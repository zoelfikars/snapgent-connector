import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { imageNames, parseInline, parseTutorial } from "../src/domain/tutorial/parse.js";
import { pickLanguage } from "../src/domain/tutorial/language.js";
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
    assert.deepEqual(imageNames(`${MD}\n@gambar(one.png)\n@gambar( two.jpg , width=20 )\n`), ["one.png", "two.jpg"]);
  });

  test("an image may give a width, a height or both; what is left out stays automatic", () => {
    const [plain, wide, tall, both, short] = parseTutorial("@gambar(a.png)\n\n@gambar(a.png, width=300)\n\n@gambar(a.png, height=50%)\n\n@gambar(a.png, width=300, height=200)\n\n@gambar(a.png, w=10, h=20)");
    assert.deepEqual(plain, { type: "image", name: "a.png" });
    assert.deepEqual(wide, { type: "image", name: "a.png", width: "300" });
    assert.deepEqual(tall, { type: "image", name: "a.png", height: "50%" });
    assert.deepEqual(both, { type: "image", name: "a.png", width: "300", height: "200" });
    assert.deepEqual(short, { type: "image", name: "a.png", width: "10", height: "20" });
  });

  test("a size that makes no sense is ignored", () => {
    const [image] = parseTutorial("@gambar(a.png, width=abc, height=0, color=red)");
    assert.deepEqual(image, { type: "image", name: "a.png" });
  });

  test("inline pieces", () => {
    assert.deepEqual(parseInline("a **b** `c`"), [{ t: "text", v: "a " }, { t: "b", v: "b" }, { t: "text", v: " " }, { t: "code", v: "c" }]);
  });
});

describe("tutorial language", () => {
  test("the saved choice wins, otherwise the browser decides, English by default", () => {
    assert.equal(pickLanguage("en", "id-ID"), "en");
    assert.equal(pickLanguage("id", "en-US"), "id");
    assert.equal(pickLanguage(undefined, "id-ID"), "id");
    assert.equal(pickLanguage(undefined, "id"), "id");
    assert.equal(pickLanguage(undefined, "fr"), "en");
    assert.equal(pickLanguage("xx", undefined), "en");
  });
});

describe("tutorial popup", () => {
  const open = (texts, images, extra = {}) => {
    const w = new JSDOM("<!doctype html><body></body>").window;
    openTutorial({ document: w.document, texts, images, ...extra });
    return w.document;
  };

  test("draws the blocks, with the image from the embedded set", () => {
    const doc = open({ id: MD, en: "" }, { "one.png": "data:image/png;base64,AAAA" }, { lang: "id" });
    assert.equal(doc.querySelector("h3").textContent, "Title");
    assert.equal(doc.querySelector("b").textContent, "world");
    assert.equal(doc.querySelectorAll("li").length, 2);
    assert.equal(doc.querySelector("img").getAttribute("src"), "data:image/png;base64,AAAA");
  });

  test("an image is sized only on the sides the tutorial names", () => {
    const images = { "a.png": "data:image/png;base64,AAAA" };
    const wide = open({ id: "@gambar(a.png, width=300)", en: "" }, images, { lang: "id" }).querySelector("img");
    assert.equal(wide.style.width, "300px");
    assert.equal(wide.style.height, "");
    const tall = open({ id: "@gambar(a.png, height=50%)", en: "" }, images, { lang: "id" }).querySelector("img");
    assert.equal(tall.style.height, "50%");
    assert.equal(tall.style.width, "");
  });

  test("text never becomes markup and only embedded images are shown", () => {
    const doc = open({ id: "<i>x</i>\n\n@gambar(a.png)", en: "" }, { "a.png": "javascript:alert(1)" }, { lang: "id" });
    assert.equal(doc.querySelector("i"), null);
    assert.equal(doc.querySelector("img"), null);
    assert.match(doc.querySelector(".zs-tut").textContent, /<i>x<\/i>[\s\S]*image missing: a\.png/);
  });

  test("opens in the given language and the switch changes it and reports the choice", () => {
    const chosen = [];
    const doc = open({ id: "Halo", en: "Hello" }, {}, { lang: "id", onLang: (lang) => chosen.push(lang) });
    assert.equal(doc.querySelector(".zs-tut").textContent, "Halo");
    assert.equal(doc.querySelector('[data-lang="id"]').getAttribute("aria-pressed"), "true");
    doc.querySelector('[data-lang="en"]').click();
    assert.equal(doc.querySelector(".zs-tut").textContent, "Hello");
    assert.equal(doc.querySelector('[data-lang="en"]').getAttribute("aria-pressed"), "true");
    doc.querySelector('[data-lang="en"]').click();
    assert.deepEqual(chosen, ["en"]);
  });

  test("a language with no text says so, and the X closes the dialog", () => {
    const doc = open({ id: "", en: "" }, {}, { lang: "en" });
    assert.match(doc.querySelector(".zs-tut").textContent, /No tutorial has been written yet/);
    doc.querySelector(".zs-mcp-pop-close").click();
    assert.equal(doc.getElementById("zs-mcp-pop"), null);
  });
});

describe("tutorial build module", () => {
  async function project(texts, images = {}) {
    const root = await mkdtemp(join(tmpdir(), "tutorial-"));
    await mkdir(join(root, "tutorial", "images"), { recursive: true });
    for (const [lang, markdown] of Object.entries(texts)) {
      await mkdir(join(root, "tutorial", lang), { recursive: true });
      await writeFile(join(root, "tutorial", lang, "tutorial.md"), markdown);
    }
    for (const [name, bytes] of Object.entries(images)) await writeFile(join(root, "tutorial", "images", name), bytes);
    return root;
  }

  test("reads each language and embeds the images the texts name, once, as data URIs", async () => {
    const root = await project({ id: "Halo\n\n@gambar(a.png)\n", en: "Hi\n\n@gambar(a.png, width=10)\n" }, { "a.png": Buffer.from([1, 2, 3]), "unused.png": Buffer.from([9]) });
    try {
      const source = await tutorialModuleSource(root);
      assert.match(source, /TUTORIAL_TEXTS = \{"id":"Halo\\n\\n@gambar\(a\.png\)\\n","en":"Hi/);
      assert.equal(source.match(/"a\.png":"data:image\/png;base64,AQID"/g).length, 1);
      assert.doesNotMatch(source, /unused/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a missing image or an unsafe name stops the build with a clear message", async () => {
    const missing = await project({ id: "@gambar(nope.png)" });
    const unsafe = await project({ en: "@gambar(../x.png)" });
    try {
      await assert.rejects(tutorialModuleSource(missing), /@gambar\(nope\.png\) not found/);
      await assert.rejects(tutorialModuleSource(unsafe), /plain file name/);
    } finally {
      await rm(missing, { recursive: true, force: true });
      await rm(unsafe, { recursive: true, force: true });
    }
  });

  test("a language without a file gives an empty text", async () => {
    const root = await project({ id: "Halo" });
    try {
      assert.match(await tutorialModuleSource(root), /"id":"Halo","en":""/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
