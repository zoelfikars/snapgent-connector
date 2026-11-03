// SPDX-License-Identifier: GPL-3.0-or-later
// Seats the control bar once per animation frame in a corner of the window, next to its show/hide button. The corner and
// whether the bar is shown are the user's choice (bar-prefs); the geometry is pure (bar-placement.js).

import { barGeometry, cornerOf, floatingStopGeometry, toggleGeometry } from "./bar-placement.js";

/**
 * @param {{ document: Document, provider: object, prefs: () => { corner: string, hidden: boolean },
 *           parts: () => { bar: HTMLElement|null, root: HTMLElement|null, menuEl: HTMLElement|null, toggleEl: HTMLElement|null,
 *                      stopEl?: HTMLElement|null, stopFloatEl?: HTMLElement|null },
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
    // While the bar is hidden its own Stop button is hidden with it: a copy of it sits on the show/hide button instead.
    if (ui.stopFloatEl && ui.stopEl) {
      const show = hidden && !obstructed && !ui.stopEl.hidden;
      ui.stopFloatEl.hidden = !show;
      if (show) {
        ui.stopFloatEl.textContent = ui.stopEl.textContent;
        ui.stopFloatEl.disabled = ui.stopEl.disabled;
        if (ui.stopEl.dataset.state) ui.stopFloatEl.dataset.state = ui.stopEl.dataset.state; else delete ui.stopFloatEl.dataset.state;
        const s = floatingStopGeometry(viewport, { width: ui.stopFloatEl.offsetWidth, height: ui.stopFloatEl.offsetHeight }, where);
        ui.stopFloatEl.style.left = `${s.left}px`;
        ui.stopFloatEl.style.top = `${s.top}px`;
      }
    }
    if (obstructed || hidden) {
      ui.bar.style.display = "none";
      if (ui.menuEl) ui.menuEl.hidden = true;
      return;
    }
    ui.bar.style.display = "flex";
    ui.bar.style.width = "";
    const g = barGeometry(viewport, { width: ui.bar.offsetWidth, height: ui.bar.offsetHeight }, where);
    ui.bar.style.maxHeight = `${g.maxHeight}px`;
    ui.bar.style.left = `${g.left}px`;
    ui.bar.style.top = `${g.top}px`;

    if (ui.menuEl && !ui.menuEl.hidden) positionMenu(ui.bar.getBoundingClientRect());
  }

  return { place };
}
