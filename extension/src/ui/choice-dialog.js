// SPDX-License-Identifier: GPL-3.0-or-later
// Asks the user to pick one of a few folders. Built like the approval dialog (confirm-dialog.js): a modal <dialog> in a CLOSED shadow
// root on a page we do not control, only real clicks count, Esc/backdrop mean "none", and the folder paths go in as text.

const STYLE = `
  :host { all: initial; --bg: #ffffff; --fg: #17181c; --muted: #5c6070; --line: #d6d8e0; --ok: #1a6bd1; }
  @media (prefers-color-scheme: dark) { :host { --bg: #1b1d24; --fg: #eceef4; --muted: #a2a7b8; --line: #343846; --ok: #7ab4ff; } }
  dialog { border: 1px solid var(--line); border-radius: 12px; padding: 0; width: min(480px, calc(100vw - 32px));
    background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  dialog::backdrop { background: rgba(0, 0, 0, .55); }
  .body { padding: 18px 20px 6px; }
  .eyebrow { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
  h2 { font-size: 16px; margin: 0 0 6px; }
  .hint { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
  .opts { display: grid; gap: 8px; padding: 0 20px; }
  button { font: inherit; text-align: left; padding: 9px 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.opt:hover, button:focus-visible { border-color: var(--ok); outline: none; }
  .name { font-weight: 600; display: block; }
  .path { font: 12px ui-monospace, monospace; color: var(--muted); word-break: break-all; }
  .actions { display: flex; justify-content: flex-end; padding: 12px 20px 18px; }
`;

const folderName = (path) => String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(path);

/** @param {{ document?: Document, shadowMode?: "open"|"closed", isTrusted?: (event: Event) => boolean }} [options] */
export function createChoiceDialog({ document: doc = globalThis.document, shadowMode = "closed", isTrusted = (event) => event.isTrusted === true } = {}) {
  let queue = Promise.resolve();

  function show({ title, hint, options }) {
    return new Promise((resolve) => {
      const host = doc.createElement("div");
      const shadow = host.attachShadow({ mode: shadowMode });
      shadow.innerHTML = `<style>${STYLE}</style><dialog aria-labelledby="t"><div class="body"><p class="eyebrow">snapgentV3</p><h2 id="t"></h2><p class="hint"></p></div>
        <div class="opts"></div><div class="actions"><button class="cancel" type="button">Cancel</button></div></dialog>`;
      const dialog = shadow.querySelector("dialog");
      shadow.querySelector("h2").textContent = title;
      shadow.querySelector(".hint").textContent = hint || "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { dialog.close(); } catch { /* not open */ }
        host.remove();
        resolve(value);
      };
      for (const path of options) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "opt";
        button.innerHTML = '<span class="name"></span><span class="path"></span>';
        button.querySelector(".name").textContent = folderName(path);
        button.querySelector(".path").textContent = path;
        button.addEventListener("click", (event) => { if (isTrusted(event)) finish(path); });
        shadow.querySelector(".opts").appendChild(button);
      }
      shadow.querySelector(".cancel").addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
      dialog.addEventListener("click", (event) => { if (event.target === dialog) finish(null); });
      doc.documentElement.appendChild(host);
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    });
  }

  return {
    /** @returns {Promise<string|null>} the chosen path, or null when the user closed it. One dialog at a time. */
    choose(request) {
      const result = queue.then(() => show(request));
      queue = result.catch(() => {});
      return result;
    },
  };
}
