// SPDX-License-Identifier: GPL-3.0-or-later
// Which language the tutorial is shown in. Pure: the saved choice and the browser's language go in, one of the two codes comes out.

export const TUTORIAL_LANGUAGES = ["id", "en"];

/** The saved choice wins; without one, an Indonesian browser gets Indonesian and everyone else English. */
export function pickLanguage(saved, browserLanguage) {
  if (TUTORIAL_LANGUAGES.includes(saved)) return saved;
  return /^id\b/i.test(String(browserLanguage || "")) ? "id" : "en";
}
