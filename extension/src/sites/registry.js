// SPDX-License-Identifier: GPL-3.0-or-later
// Single source of truth for every supported AI chat site. The manifest
// generator, the background worker and the popup all derive from this list, so
// adding a site means adding ONE entry here plus its adapter file.

/**
 * @typedef {Object} Site
 * @property {string}   id           Adapter file name under providers/ (no extension).
 * @property {string}   name         Display name.
 * @property {string[]} matches      Content-script URL match patterns.
 * @property {string[]} [extraHosts] Extra host permissions beyond `matches`.
 * @property {string[]} [mainWorld]  Scripts that must run in the page's MAIN world.
 */

/** @type {Site[]} */
export const SITES = [
  { id: "deepseek", name: "DeepSeek", matches: ["https://chat.deepseek.com/*"], extraHosts: ["https://deepseek.com/*"] },
  { id: "chatgpt", name: "ChatGPT", matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"], mainWorld: ["providers/chatgpt-cm.js"] },
  { id: "claude", name: "Claude", matches: ["https://claude.ai/*"] },
  { id: "gemini", name: "Gemini", matches: ["https://gemini.google.com/*"] },
  { id: "kimi", name: "Kimi", matches: ["https://www.kimi.ai/*", "https://kimi.ai/*"] },
  { id: "glm", name: "GLM", matches: ["https://chat.z.ai/*"] },
  { id: "qwen", name: "Qwen", matches: ["https://chat.qwen.ai/*"], mainWorld: ["providers/qwen-net.js"] },
  { id: "arena", name: "Arena", matches: ["https://arena.ai/*"] },
  { id: "meta", name: "Meta AI", matches: ["https://www.meta.ai/*", "https://meta.ai/*"] },
  { id: "ptero", name: "Ptero", matches: ["https://ptero.pro/*"] },
  { id: "grok", name: "Grok", matches: ["https://grok.com/*"] },
  { id: "mistral", name: "Mistral", matches: ["https://chat.mistral.ai/*"] },
];

export const BRIDGE_PORT = 17613;

/** Every URL pattern a content script runs on. */
export const allMatches = () => SITES.flatMap((site) => site.matches);

/** Host names (no scheme/path) used to recognise a supported tab. */
export const allHostnames = () => [
  ...new Set(
    SITES.flatMap((site) => [...site.matches, ...(site.extraHosts || [])]).map((pattern) => new URL(pattern.replace("*", "x")).hostname),
  ),
];
