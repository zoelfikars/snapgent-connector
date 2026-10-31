// SPDX-License-Identifier: GPL-3.0-or-later
// The dialog that asks the user to approve a risky action. It lives on a page we do not control, so:
//  - it is a modal <dialog> (top layer: page content cannot be drawn over it) inside a CLOSED shadow
//    root (page scripts and styles cannot reach in or restyle it);
//  - only a real user gesture counts: synthetic clicks a page script dispatches are ignored;
//  - the safe choice (Deny) has focus, Esc/backdrop/timeout all mean "no", and Allow stays disabled
//    for a moment so a click meant for something else cannot land on it;
//  - the action text goes in as textContent, never as HTML.

const RISK_LABELS = {
  destructive: "Deletes data",
  execute: "Runs a program",
  vcs: "Changes git history",
  read: "Reads a sensitive file",
  write: "Changes files",
};
const MAX_DESCRIPTION_CHARS = 600;

const STYLE = `
  :host { all: initial; }
  dialog { border: 1px solid var(--line); border-radius: 12px; padding: 0; width: min(480px, calc(100vw - 32px));
    background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  dialog::backdrop { background: rgba(0, 0, 0, .55); }
  :host { --bg: #ffffff; --fg: #17181c; --muted: #5c6070; --line: #d6d8e0; --code: #f1f2f6; --danger: #b3261e; --ok: #1a6bd1; }
  @media (prefers-color-scheme: dark) { :host { --bg: #1b1d24; --fg: #eceef4; --muted: #a2a7b8; --line: #343846; --code: #101218; --danger: #ff8a80; --ok: #7ab4ff; } }
  .body { padding: 18px 20px 6px; }
  .eyebrow { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
  .risk { display: inline-block; font-size: 12px; font-weight: 600; color: var(--danger); border: 1px solid currentColor; border-radius: 999px; padding: 1px 9px; margin: 0 0 10px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  pre { margin: 0 0 8px; padding: 10px 12px; background: var(--code); border: 1px solid var(--line); border-radius: 8px;
    white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; font: 13px/1.4 ui-monospace, monospace; }
  .hint { margin: 0 0 14px; font-size: 12px; color: var(--muted); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 20px 18px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.deny { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
  button.allow { border-color: var(--ok); color: var(--ok); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button:focus-visible { outline: 2px solid var(--ok); outline-offset: 2px; }
`;

/**
 * @param {{ document?: Document, shadowMode?: "open"|"closed", allowDelayMs?: number, timeoutMs?: number,
 *           isTrusted?: (event: Event) => boolean }} [options]
 */
export function createConfirmDialog({
  document: doc = globalThis.document,
  shadowMode = "closed",
  allowDelayMs = 700,
  timeoutMs = 120000,
  isTrusted = (event) => event.isTrusted === true,
} = {}) {
  let queue = Promise.resolve();

  function show({ description, risk }) {
    return new Promise((resolve) => {
      const host = doc.createElement("div");
      const shadow = host.attachShadow({ mode: shadowMode });
      shadow.innerHTML = `<style>${STYLE}</style><dialog aria-labelledby="t">
        <div class="body">
          <p class="eyebrow">snapgentV3</p>
          <span class="risk"></span>
          <h2 id="t">The AI wants to do this:</h2>
          <pre class="action"></pre>
          <p class="hint">Nothing happens unless you allow it. Closing this window counts as "Deny".</p>
        </div>
        <div class="actions"><button class="deny" type="button" autofocus>Deny</button><button class="allow" type="button" disabled>Allow</button></div>
      </dialog>`;
      const dialog = shadow.querySelector("dialog");
      const riskLabel = shadow.querySelector(".risk");
      riskLabel.textContent = RISK_LABELS[risk] || "Needs your approval";
      shadow.querySelector(".action").textContent = String(description || "").slice(0, MAX_DESCRIPTION_CHARS);
      const deny = shadow.querySelector(".deny");
      const allow = shadow.querySelector(".allow");

      let timers = [];
      let settled = false;
      const finish = (approved) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        try { dialog.close(); } catch { /* not open */ }
        host.remove();
        resolve(approved);
      };

      deny.addEventListener("click", () => finish(false));
      allow.addEventListener("click", (event) => { if (isTrusted(event) && !allow.disabled) finish(true); });
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); }); // Esc
      dialog.addEventListener("click", (event) => { if (event.target === dialog) finish(false); }); // backdrop

      timers.push(setTimeout(() => { allow.disabled = false; }, allowDelayMs));
      timers.push(setTimeout(() => finish(false), timeoutMs));

      doc.documentElement.appendChild(host);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      deny.focus();
    });
  }

  return {
    /** @returns {Promise<boolean>} true only when the user pressed Allow. One dialog at a time. */
    ask(request) {
      const result = queue.then(() => show(request));
      queue = result.catch(() => {});
      return result;
    },
  };
}
