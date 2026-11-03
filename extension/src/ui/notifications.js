// SPDX-License-Identifier: GPL-3.0-or-later
// Transient messages drawn into the extension's own root element: toasts, banners, the "bridge is
// down" and "reload this page" alerts, and the screenshot popup.

const TOAST_FADE_IN_MS = 10;
const TOAST_VISIBLE_MS = 3500;
const TOAST_FADE_OUT_MS = 300;

/**
 * @param {{ root: HTMLElement, reload?: () => void }} deps
 */
export function createNotifications({ root, reload = () => globalThis.location.reload() }) {
  const doc = root.ownerDocument;
  // The one connection-level alert on screen (bridge lost, or this page is stale). They replace each other.
  let connectionAlert = null;

  function element(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function toast(message) {
    const el = element("div", "zs-toast", message);
    root.appendChild(el);
    setTimeout(() => el.classList.add("show"), TOAST_FADE_IN_MS);
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), TOAST_FADE_OUT_MS); }, TOAST_VISIBLE_MS);
  }

  /** A dismissible banner. `kind` is a CSS modifier ("warn", "limit"). Text is set as text, never HTML. */
  function banner(kind, title, message) {
    const el = element("div", `zs-banner ${kind}`);
    el.append(element("div", "zs-banner-t", title), element("div", "zs-banner-m", message));
    const actions = element("div", "zs-banner-acts");
    const close = element("button", "zs-banner-x", "Close");
    close.addEventListener("click", () => el.remove());
    actions.append(close);
    el.append(actions);
    root.appendChild(el);
    return el;
  }

  function clearConnectionAlert() {
    if (connectionAlert) { connectionAlert.remove(); connectionAlert = null; }
  }

  /** The page outlived its extension build. Never self-heals, so it offers the reload and no Close. */
  function showStaleExtension() {
    clearConnectionAlert();
    if (root.querySelector(".zs-banner.zs-stale")) return;
    const el = element("div", "zs-banner limit zs-stale");
    const actions = element("div", "zs-banner-acts");
    const button = element("button", "zs-banner-reload", "Reload page");
    button.addEventListener("click", reload);
    actions.append(button);
    el.append(element("div", "zs-banner-t", "⚠ Reload page"), element("div", "zs-banner-m", "snapgentV3 was updated. Reload this page to continue."), actions);
    root.appendChild(el);
    connectionAlert = el;
  }

  /** Show (true) or clear (false) the red "bridge stopped" banner. */
  function setBridgeLost(lost) {
    if (!lost) { clearConnectionAlert(); return; }
    if (connectionAlert) return;
    const el = element("div", "zs-banner limit");
    const actions = element("div", "zs-banner-acts");
    const close = element("button", "zs-banner-x", "Close");
    close.addEventListener("click", () => { el.remove(); if (connectionAlert === el) connectionAlert = null; });
    actions.append(close);
    el.append(
      element("div", "zs-banner-t", "⚠ snapgentV3 disconnected"),
      element("div", "zs-banner-m", "Bridge stopped. Start the bridge again and keep your project open in VS Code."),
      actions,
    );
    root.appendChild(el);
    connectionAlert = el;
  }

  return { toast, banner, showStaleExtension, setBridgeLost };
}
