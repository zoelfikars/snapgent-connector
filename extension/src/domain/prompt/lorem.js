// SPDX-License-Identifier: GPL-3.0-or-later
// Filler text of an exact length, for finding out how much one message a chat site accepts. Pure and always the same for the same length.

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
const WORDS_PER_SENTENCE = 12;

/** `chars` characters of lorem ipsum (empty for anything that is not a positive number). */
export function loremIpsum(chars) {
  const size = Math.floor(Number(chars));
  if (!Number.isFinite(size) || size <= 0) return "";
  const words = [];
  let length = 0;
  for (let i = 0; length < size; i++) {
    const word = WORDS[i % WORDS.length] + ((i + 1) % WORDS_PER_SENTENCE === 0 ? "." : "");
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ").slice(0, size);
}
