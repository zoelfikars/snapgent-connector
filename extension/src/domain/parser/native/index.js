// SPDX-License-Identifier: GPL-3.0-or-later
// The calls a model writes in ITS OWN markup instead of our command format (DeepSeek's DSML, and whatever another AI comes up
// with). One registry for every site: a format is { id, recognises(text), parse(text) -> [{ tool, arguments }], isOpen(text) }, and
// adding one is a file here plus a line below. Nothing in it knows which site the text came from.

import { dsml } from "./dsml.js";

const FORMATS = [dsml];

/** Teach the parser one more native format (the same shape as the built-in ones). */
export const registerNativeFormat = (format) => { if (!FORMATS.some((known) => known.id === format.id)) FORMATS.push(format); };

export const recognisesNative = (text) => FORMATS.some((format) => format.recognises(text));
export const hasOpenNative = (text) => FORMATS.some((format) => format.recognises(text) && format.isOpen(text));

/** The calls of the first format that reads any. */
export function parseNative(text) {
  for (const format of FORMATS) {
    if (!format.recognises(text)) continue;
    const calls = format.parse(text);
    if (calls.length) return calls.map((call) => ({ ...call, native: format.id })); // the batch's answer then tells the model which format to use
  }
  return [];
}
