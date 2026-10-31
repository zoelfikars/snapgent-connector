import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TurnMemory } from "../src/application/turn-memory.js";

function memory({ conversation = "c1", rendered = true } = {}) {
  const state = { conversation, rendered };
  const mem = new TurnMemory({
    conversationKey: () => state.conversation,
    keyOf: (item) => item.key,
    isRendered: () => state.rendered,
    textOf: (item) => item.text,
  });
  return { mem, state };
}
const turn = (key, text) => ({ key, text });

describe("TurnMemory", () => {
  test("recognises a turn after its node was replaced, by key and text prefix", () => {
    const { mem } = memory();
    mem.remember(turn("k1", '{"command":"read_file","arguments":{"path":"a"}'));
    const rerendered = turn("k1", '{"command":"read_file","arguments":{"path":"a"}}   fully streamed now');
    assert.equal(mem.has(rerendered, rerendered.text), true);
  });

  test("a different turn at the same position does not match", () => {
    const { mem } = memory();
    mem.remember(turn("k1", "the first command text, long enough"));
    assert.equal(mem.has(turn("k1", "something else entirely, also long"), "something else entirely, also long"), false);
  });

  test("another conversation or another key does not match", () => {
    const { mem, state } = memory();
    const first = turn("k1", "identical command text in two chats");
    mem.remember(first);
    assert.equal(mem.has(turn("k2", first.text), first.text), false);
    state.conversation = "c2";
    assert.equal(mem.has(first, first.text), false);
  });

  test("text too short to identify a turn is not remembered (it would match any later turn)", () => {
    const { mem } = memory();
    mem.remember(turn("k1", "  {\"co  "));
    assert.equal(mem.has(turn("k1", "anything at all, longer"), "anything at all, longer"), false);
  });

  test("a turn that is not on the page, or no turn at all, is ignored", () => {
    const { mem, state } = memory();
    state.rendered = false;
    mem.remember(turn("k1", "this turn is not rendered right now"));
    mem.remember(null);
    state.rendered = true;
    assert.equal(mem.has(turn("k1", "this turn is not rendered right now"), "this turn is not rendered right now"), false);
  });

  test("forget removes it, and forgetting something unknown is harmless", () => {
    const { mem } = memory();
    const item = turn("k1", "a command that was halted mid-way");
    mem.remember(item);
    mem.forget(turn("zzz", "x"));
    assert.equal(mem.has(item, item.text), true);
    mem.forget(item);
    assert.equal(mem.has(item, item.text), false);
  });

  test("a port that throws (page navigating) never escapes", () => {
    const mem = new TurnMemory({ conversationKey: () => { throw new Error("gone"); }, keyOf: () => "k", isRendered: () => true, textOf: () => "a long enough command text" });
    mem.remember({});
    mem.forget({});
    assert.equal(mem.has({}, "x"), false);
  });

  test("only the first 60 characters are compared, so a longer final text still matches", () => {
    const { mem } = memory();
    const early = "x".repeat(70);
    mem.remember(turn("k1", early));
    assert.equal(mem.has(turn("k1", ""), early + "tail"), true);
    assert.equal(mem.has(turn("k1", ""), "y" + early), false);
  });
});
