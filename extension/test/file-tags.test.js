import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findTags, matchPaths, tagText, trailingTag } from "../src/domain/prompt/file-tags.js";

const FILES = new Set(["src/a.js", "README.md", "docs/My Notes.md", "docs/My", "it's.txt"]);
const isFile = (path) => FILES.has(path);

describe("tagText", () => {
  test("a plain path is written as it is, a path with spaces is quoted", () => {
    assert.equal(tagText("src/a.js"), "@src/a.js ");
    assert.equal(tagText("docs/My Notes.md"), '@"docs/My Notes.md" ');
    assert.equal(tagText("it's a file.txt"), '@"it\'s a file.txt" ');
    assert.equal(tagText(`both " and ' x.txt`), "@`both \" and ' x.txt` ");
  });
});

describe("trailingTag", () => {
  test("an @ at the end of the text is being typed, with what follows it as the query", () => {
    assert.deepEqual(trailingTag("@"), { start: 0, query: "" });
    assert.deepEqual(trailingTag("explain @src/a"), { start: 8, query: "src/a" });
    assert.deepEqual(trailingTag("a\n@x"), { start: 2, query: "x" });
  });

  test("inside quotes the query may hold spaces until the closing quote", () => {
    assert.deepEqual(trailingTag('see @"docs/My No'), { start: 4, query: "docs/My No" });
    assert.equal(trailingTag('see @"docs/My Notes.md" and'), null);
  });

  test("a finished tag followed by words, an address, or no @ is not a tag being typed", () => {
    assert.equal(trailingTag("see @src/a.js and more"), null);
    assert.equal(trailingTag("mail me at a@b.com"), null);
    assert.equal(trailingTag("nothing here"), null);
    assert.equal(trailingTag(""), null);
  });

  test("an earlier address does not hide a tag being typed after it", () => {
    assert.deepEqual(trailingTag("a@b.com and @sr"), { start: 12, query: "sr" });
  });
});

describe("matchPaths", () => {
  const paths = ["internal/todos/service.go", "internal/platform/router.go", "docs/service-notes.md", "README.md"];
  test("every word must be in the path, and a hit in the file name comes first", () => {
    assert.deepEqual(matchPaths(paths, "service"), ["internal/todos/service.go", "docs/service-notes.md"]);
    assert.deepEqual(matchPaths(paths, "internal router"), ["internal/platform/router.go"]);
    assert.deepEqual(matchPaths(paths, "todos"), ["internal/todos/service.go"]);
    assert.deepEqual(matchPaths(paths, "INTERNAL SERVICE").length, 1);
  });
  test("no words means everything", () => assert.equal(matchPaths(paths, "  ").length, 4));
});

describe("findTags", () => {
  test("plain, quoted and punctuated tags name files; unknown ones are ignored", () => {
    assert.deepEqual(findTags("see @src/a.js, and @README.md. Also @nope.txt", isFile), ["src/a.js", "README.md"]);
    assert.deepEqual(findTags('read @"docs/My Notes.md" then @\'it\'s.txt\'', isFile), ["docs/My Notes.md"]);
    assert.deepEqual(findTags("see @`docs/My Notes.md`", isFile), ["docs/My Notes.md"]);
  });

  test("an unquoted name that runs into spaces is read as the longest file name", () => {
    assert.deepEqual(findTags("open @docs/My Notes.md please", isFile), ["docs/My Notes.md"]);
  });

  test("each file once, in order of appearance, and an address is not a tag", () => {
    assert.deepEqual(findTags("@README.md and @src/a.js and @README.md", isFile), ["README.md", "src/a.js"]);
    assert.deepEqual(findTags("mail x@src/a.js", isFile), []);
  });
});
