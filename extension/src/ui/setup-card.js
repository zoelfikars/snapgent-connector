// SPDX-License-Identifier: GPL-3.0-or-later
// The first-run card in the page corner: how to get from "nothing running" to a working agent.

import { escapeHtml } from "./html.js";

/**
 * Show the card only while it can help: the user has not dismissed it, the bridge is not connected,
 * and this chat is somewhere an agent could start (a blank chat, or one with a session). A person just
 * READING an old conversation does not need a "bridge is down" popup.
 */
export function shouldShowSetup({ dismissed, bridgeConnected, hasSession, chatIsEmpty }) {
  if (dismissed || bridgeConnected) return false;
  return hasSession || chatIsEmpty;
}

export const SETUP_STEPS = [
  "Start the bridge: <code>snapgent.exe</code> (Windows), <code>./snapgent</code> (Linux) or <code>python3 server/snapgent.py</code> (macOS)",
  "Type <b>y</b> in the bridge window when it asks about this extension (only the first time)",
  "Press <b>Start</b> in the bar",
];

const COPIED_MS = 1600;

/**
 * @param {{ document: Document, githubUrl: string, onDismiss: () => void }} deps
 * @returns {{ show: () => void, hide: () => void, isShown: () => boolean }}
 */
export function createSetupCard({ document, githubUrl, onDismiss }) {
  let card = null;

  function build() {
    card = document.createElement("div");
    card.id = "zs-setup";
    card.hidden = true;
    card.innerHTML =
      `<div id="zs-setup-head"><span id="zs-setup-logo">snapgentV3</span><span id="zs-setup-tag">Setup</span></div>` +
      `<div id="zs-setup-sub">${SETUP_STEPS.length} quick steps.</div>` +
      `<ol id="zs-setup-steps">${SETUP_STEPS.map((step) => `<li>${step}</li>`).join("")}</ol>` +
      `<div class="zs-setup-copy-row"><input type="text" id="zs-setup-link" readonly value="${escapeHtml(githubUrl)}"><button id="zs-setup-copy">Copy</button></div>` +
      `<button id="zs-setup-dismiss">OK</button>`;
    document.documentElement.appendChild(card);

    const copy = card.querySelector("#zs-setup-copy");
    copy.addEventListener("click", () => {
      try {
        document.defaultView.navigator.clipboard.writeText(githubUrl);
      } catch {
        const input = card.querySelector("#zs-setup-link");
        input.select();
        try { document.execCommand("copy"); } catch { /* the link stays selected for a manual copy */ }
      }
      copy.textContent = "Copied!";
      setTimeout(() => { copy.textContent = "Copy"; }, COPIED_MS);
    });
    card.querySelector("#zs-setup-dismiss").addEventListener("click", () => {
      onDismiss();
      hide();
    });
  }

  function show() {
    if (!card) build();
    card.hidden = false;
  }

  function hide() {
    if (card) card.hidden = true;
  }

  return { show, hide, isShown: () => !!card && !card.hidden };
}
