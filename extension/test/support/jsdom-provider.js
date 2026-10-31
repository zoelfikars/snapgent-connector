// Loads a legacy provider script into a real DOM (jsdom), with the same globals the bundled
// globals.js gives it in the browser. Lets adapter tests run against captured page markup.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as parser from "../../src/domain/parser/index.js";
import * as domain from "../../src/domain/index.js";
import * as chat from "../../src/infrastructure/chat/index.js";

const root = new URL("../../", import.meta.url);
export const fixture = (name) => readFileSync(new URL(`test/fixtures/${name}`, root), "utf8");

export function loadProvider(providerFile, html, url = "https://chatgpt.com/c/test") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  const { window } = dom;
  const { parser: _unused, ...prompt } = domain;
  Object.assign(window, { ZSParse: parser, ZSChat: chat, ZS: prompt });
  const source = readFileSync(new URL(`legacy/providers/${providerFile}`, root), "utf8");
  const provider = window.eval(`${source}\n;ZSProvider`);
  return { provider, window, document: window.document };
}
