// SPDX-License-Identifier: GPL-3.0-or-later
// Single source of truth for every supported AI chat site. The manifest
// generator, the background worker and the popup all derive from this list, so
// adding a site means adding ONE entry here.

/**
 * @typedef {Object} Site
 * @property {string}   id           Short stable id.
 * @property {string}   name         Display name.
 * @property {string[]} matches      Content-script URL match patterns.
 * @property {string}   url         Where the "switch AI" menu sends the user.
 * @property {string[]} [extraHosts] Extra host permissions beyond `matches`.
 * @property {boolean} [accounts]  The user may keep several logins and switch between them (cookie snapshot and swap).
 * @property {string[]} [accountHosts] The host names whose cookies are that login (default: the match hosts).
 * @property {string[]} [accountStorage] localStorage keys that are also part of that login (DeepSeek keeps its token there).
 */

/** @type {Site[]} */
export const SITES = [
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", matches: ["https://chat.deepseek.com/*"], extraHosts: ["https://deepseek.com/*"], accounts: true, accountHosts: ["deepseek.com"], accountStorage: ["userToken"] },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"] },
  // Accounts (cookie snapshot and swap, plus the localStorage keys a login also lives in) are offered for Claude and DeepSeek: a site gets them once its cookies are known to
  // be all a login lives in.
  { id: "claude", name: "Claude", url: "https://claude.ai/new", matches: ["https://claude.ai/*"], accounts: true, accountHosts: ["claude.ai", "anthropic.com"] },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", matches: ["https://gemini.google.com/*"] },
  { id: "kimi", name: "Kimi", url: "https://www.kimi.ai/", matches: ["https://www.kimi.ai/*", "https://kimi.ai/*"] },
  { id: "glm", name: "GLM", url: "https://chat.z.ai/", matches: ["https://chat.z.ai/*"] },
  { id: "qwen", name: "Qwen", url: "https://chat.qwen.ai/", matches: ["https://chat.qwen.ai/*"] },
  { id: "arena", name: "Arena", url: "https://arena.ai/text/direct", matches: ["https://arena.ai/*"] },
  { id: "meta", name: "Meta AI", url: "https://www.meta.ai/", matches: ["https://www.meta.ai/*", "https://meta.ai/*"] },
  { id: "ptero", name: "Ptero", url: "https://ptero.pro/", matches: ["https://ptero.pro/*"] },
  { id: "grok", name: "Grok", url: "https://grok.com/", matches: ["https://grok.com/*"] },
  { id: "mistral", name: "Mistral", url: "https://chat.mistral.ai/code", matches: ["https://chat.mistral.ai/*"] },
];

/** The "switch AI" shortcuts: every supported site. */
export const SITE_LINKS = SITES.map(({ name, url }) => ({ name, url }));

export const BRIDGE_PORT = 17613;

/** Every URL pattern a content script runs on. */
export const allMatches = () => SITES.flatMap((site) => site.matches);

/** Host names (no scheme/path) used to recognise a supported tab. */
export const allHostnames = () => [
  ...new Set(
    SITES.flatMap((site) => [...site.matches, ...(site.extraHosts || [])]).map((pattern) => new URL(pattern.replace("*", "x")).hostname),
  ),
];

const hostnameOf = (pattern) => new URL(pattern.replace("*", "x")).hostname;

/** The registry entry whose match patterns cover this host name, or undefined. */
export const siteFor = (hostname) => SITES.find((site) => site.matches.some((pattern) => hostnameOf(pattern) === hostname));

/** The site whose logins can be switched (an account entry), or undefined. */
export const accountSiteFor = (hostname) => {
  const site = siteFor(hostname);
  return site && site.accounts ? site : undefined;
};

/** The host names a site's cookies live on. */
export const accountHostsOf = (site) => site.accountHosts || site.matches.map(hostnameOf);

/** The localStorage keys that are part of a site's login (none for most sites). */
export const accountStorageOf = (site) => site.accountStorage || [];
