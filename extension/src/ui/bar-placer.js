// SPDX-License-Identifier: GPL-3.0-or-later
// Seats the control bar once per animation frame in a corner of the window, next to its show/hide button. The corner and
// whether the bar is shown are the user's choice (bar-prefs); the geometry is pure (bar-placement.js).

import { barGeometry, cornerOf, pillPosition, toggleGeometry } from "./bar-placement.js";

/**
 * @param {{ document: Document, provider: object, prefs: () => { corner: string, hidden: boolean },
 *           parts: () => { bar: HTMLElement|null, root: HTMLElement|null, menuEl: HTMLElement|null, unstableEl: HTMLElement|null, toggleEl: HTMLElement|null },
 *           positionMenu: (anchorRect: object) => void }} deps
 *   `parts` is a function because the bar is created later than this placer (by build()).
 */
export function createBarPlacer({ document, provider, prefs, parts, positionMenu }) {
  function place() {
    const ui = parts();
    if (!ui.bar) return;
    // A page re-render can detach our root from <html>: put it back (the next frame is already scheduled by the caller).
    if (ui.root && !ui.root.isConnected) { try { document.documentElement.appendChild(ui.root); } catch {} }

    const win = document.defaultView;
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    const { corner, hidden } = prefs();
    const where = cornerOf(corner);
    // A bot check or a login/consent modal is up: stay out of its way entirely until it clears.
    const obstructed = !!((provider.captchaPresent && provider.captchaPresent()) || (provider.overlayBlocking && provider.overlayBlocking()));

    if (ui.toggleEl) {
      const t = toggleGeometry(viewport, where);
      ui.toggleEl.style.display = obstructed ? "none" : "flex";
      ui.toggleEl.style.left = `${t.left}px`;
      ui.toggleEl.style.top = `${t.top}px`;
      ui.toggleEl.setAttribute("aria-pressed", hidden ? "false" : "true");
      ui.toggleEl.title = hidden ? "Show snapgent" : "Hide snapgent";
    }
    if (obstructed || hidden) {
      ui.bar.style.display = "none";
      if (ui.menuEl) ui.menuEl.hidden = true;
      if (ui.unstableEl) ui.unstableEl.hidden = true;
      return;
    }
    ui.bar.style.display = "flex";
    ui.bar.style.width = "";
    const g = barGeometry(viewport, { width: ui.bar.offsetWidth, height: ui.bar.offsetHeight }, where);
    ui.bar.style.maxHeight = `${g.maxHeight}px`;
    ui.bar.style.left = `${g.left}px`;
    ui.bar.style.top = `${g.top}px`;

    if (ui.unstableEl) {
      const pos = pillPosition(ui.bar.getBoundingClientRect(), ui.unstableEl.offsetHeight, where);
      ui.unstableEl.hidden = !pos;
      if (pos) { ui.unstableEl.style.left = `${pos.left}px`; ui.unstableEl.style.top = `${pos.top}px`; }
    }
    if (ui.menuEl && !ui.menuEl.hidden) positionMenu(ui.bar.getBoundingClientRect());
  }

  return { place };
}
