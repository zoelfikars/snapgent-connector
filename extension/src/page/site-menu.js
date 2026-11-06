// SPDX-License-Identifier: GPL-3.0-or-later
// The menu behind the "switch AI" pill: shortcuts to the other chat sites, the MCP and skills settings, where the bar sits, and the
// calibration of this site.

import { SITE_LINKS } from "../sites/registry.js";
import { switchMenuHtml } from "../ui/index.js";

/**
 * @param {{ document: Document, window: Window, menu: HTMLElement, button: HTMLElement, group: object,
 *           provider: object, settings: object, serverDirectory: object, skills: object, calibration: object,
 *           barPrefs: { get: () => object, set: (change: object) => void }, preferences: object, refreshTarget: () => void }} deps
 * @returns {{ toggle: (toSupport: boolean) => void, close: () => void, isOpen: () => boolean }}
 */
export function createSiteMenu({ document, window, menu, button, group, provider, calibration, barPrefs }) {
  const close = () => { menu.hidden = true; };
  group.add({ close });

  function fill() {
    menu.innerHTML = switchMenuHtml(SITE_LINKS, provider.displayName);
    menu.querySelectorAll("button.zs-site-opt[data-u], .zs-tip-opt[data-u]").forEach((link) => link.addEventListener("click", () => {
      try { window.open(link.dataset.u, "_blank", "noopener"); } catch { /* popups blocked */ }
      close();
    }));
    const on = (selector, action) => {
      const el = menu.querySelector(selector);
      if (el) el.addEventListener("click", (event) => { event.stopPropagation(); close(); action(); });
    };
  }

  /** `toSupport` scrolls the panel to its last section (the support links); otherwise it opens at the top. */
  function toggle(toSupport) {
    const wasOpen = !menu.hidden;
    group.closeAll();
    if (wasOpen) return;
    menu.hidden = false;
    fill(); // rebuilt on every open: the first render ran before the bridge status arrived
    // The panel gets its max-height from the placement loop on the next frame; scrolling before that is a no-op.
    window.requestAnimationFrame(() => { if (!menu.hidden) menu.scrollTop = toSupport ? menu.scrollHeight : 0; });
  }

  button.addEventListener("click", (event) => { event.stopPropagation(); toggle(false); });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  }, true);

  return { toggle, close, isOpen: () => !menu.hidden };
}
