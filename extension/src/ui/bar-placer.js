// SPDX-License-Identifier: GPL-3.0-or-later
// Seats the control bar on the page, once per animation frame: inside the site's composer (inline), reserved above it
// (anchored), floating above the editor, or out of the way. Which of those applies and the geometry of each are pure
// (bar-placement.js); this does the DOM work for one mode each and cleans up when it leaves a mode.

import { anchoredGeometry, chooseBarMode, floatingGeometry, pillPosition, windowGeometry } from "./bar-placement.js";

/**
 * @param {{ document: Document, provider: object,
 *           parts: () => { bar: HTMLElement|null, root: HTMLElement|null, menuEl: HTMLElement|null, unstableEl: HTMLElement|null },
 *           positionMenu: (anchorRect: object) => void }} deps
 *   `parts` is a function because the bar is created later than this placer (by build()).
 */
export function createBarPlacer({ document, provider, parts, positionMenu }) {
  // Where the bar lives INSIDE the site's composer. We insert it as a real,
  // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
  // takes the full composer width and never overlaps the site's own controls.
  // The mount point is derived from each provider's composerFrame()+getEditor(),
  // or a provider can override it via barMount(). Returns {parent, before}.
  // The provider decides the exact mount (it knows which element is the input
  // box and where a child reflows cleanly). If a provider doesn't supply one,
  // we fall back to the floating bar rather than risk overlapping its layout.
  function computeBarMount() {
    if (!provider.barMount) return null;
    const m = provider.barMount();
    return (m && m.parent && m.parent.isConnected) ? m : null;
  }

  // Anchored mode bookkeeping: the composer element whose top padding we are
  // borrowing to seat the bar (see seatAnchored). Cleared when we leave anchored
  // mode so the site's composer returns to its normal layout.
  let anchorPadEl = null;
  let ui = null; // the bar's parts, refreshed at the start of every pass (they are created by build())
  function clearAnchorPad() {
    if (anchorPadEl) { try { anchorPadEl.style.paddingTop = ""; } catch {} anchorPadEl = null; }
  }

  // Position the floating "⚠ unstable" pill just above the bar's left edge.
  function placeUnstable() {
    const u = ui.unstableEl;
    if (!u) return;
    const pos = ui.bar && ui.bar.style.display !== "none" ? pillPosition(ui.bar.getBoundingClientRect(), u.offsetHeight) : null;
    if (!pos) { if (!u.hidden) u.hidden = true; return; }
    if (u.hidden) u.hidden = false;
    u.style.left = pos.left + "px";
    u.style.top = pos.top + "px";
  }

  // Which of the four modes applies, and the geometry of each, is src/ui/bar-placement.js. These four
  // functions only do the DOM work for one mode each.
  function hideBar() {
    ui.bar.style.display = "none";
    clearAnchorPad();
    if (ui.menuEl) ui.menuEl.hidden = true;
  }

  // Preferred: a real node inside the composer (no overlap, full width).
  function seatInline(mount) {
    clearAnchorPad();
    if (ui.bar.parentElement !== mount.parent || ui.bar.nextElementSibling !== mount.before) {
      try { mount.parent.insertBefore(ui.bar, mount.before || null); } catch {}
    }
    if (!ui.bar.classList.contains("zs-bar-inline")) {
      ui.bar.classList.add("zs-bar-inline");
      ui.bar.style.cssText = ""; // drop any leftover float positioning
    }
    // Transparent (blends in) when mounted INSIDE the input box; surface card when mounted ABOVE it.
    ui.bar.classList.toggle("zs-bar-inside", !!mount.inside);
    ui.bar.style.display = "flex";
    if (ui.menuEl && !ui.menuEl.hidden) positionMenu(ui.bar.getBoundingClientRect());
  }

  // The provider wants the in-composer LOOK but its composer is a framework-reconciled subtree we must
  // NOT insert into (Kimi's Vue tree would reuse the bar node as a host and nest the editor inside it).
  // So the bar stays in our own #zs-root, fixed to the composer's top edge, with that strip RESERVED as
  // padding-top on the composer so it reads as in-flow without becoming a child of the framework's DOM.
  function seatAnchored(anchorEl) {
    ui.bar.classList.remove("zs-bar-inline", "zs-bar-inside");
    ui.bar.classList.add("zs-bar-anchored");
    if (ui.root && ui.bar.parentElement !== ui.root) ui.root.appendChild(ui.bar);
    const r = anchorEl.getBoundingClientRect();
    if (!r.width) { hideBar(); return; }
    ui.bar.style.display = "flex";
    const g = anchoredGeometry(r, ui.bar.offsetHeight);
    if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
    anchorPadEl = anchorEl;
    anchorEl.style.paddingTop = g.paddingTop + "px";
    ui.bar.style.left = g.left + "px";
    ui.bar.style.top = g.top + "px";
    ui.bar.style.width = g.width + "px";
    if (ui.menuEl && !ui.menuEl.hidden) {
      ui.bar.classList.remove("zs-bar-inline"); // ensure fixed geometry for the menu maths
      positionMenu({ left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + (ui.bar.offsetHeight || 34) });
    }
  }

  // Fallback: float just above the editor, for sites where no clean mount could be resolved.
  function seatFloating() {
    ui.bar.classList.remove("zs-bar-anchored");
    clearAnchorPad();
    if (ui.bar.classList.contains("zs-bar-inline")) {
      ui.bar.classList.remove("zs-bar-inline");
      if (ui.root && ui.bar.parentElement !== ui.root) ui.root.appendChild(ui.bar);
    }
    const f = (provider.getEditor && provider.getEditor()) || (provider.composerFrame && provider.composerFrame());
    ui.bar.style.display = "flex";
    // No text box to float above (not calibrated yet, or it is gone): sit at the bottom of the window, never vanish.
    const win = document.defaultView;
    const g = f ? floatingGeometry(f.getBoundingClientRect(), ui.bar.offsetHeight) : windowGeometry({ width: win.innerWidth, height: win.innerHeight }, ui.bar.offsetHeight);
    if (!g) { ui.bar.style.display = "none"; return; }
    ui.bar.style.width = g.width + "px";
    ui.bar.style.left = g.left + "px";
    ui.bar.style.top = g.top + "px";
    // Keep the open "more" menu anchored to the bar, opening upward.
    if (ui.menuEl && !ui.menuEl.hidden) positionMenu(ui.bar.getBoundingClientRect());
  }

  function place() {
    ui = parts();
    if (!ui.bar) return;

    // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena when the message frame
    // teleports) can detach our whole #zs-root from <html>, taking the bar with it. Re-append it; this
    // rAF loop is resilient (its next frame is scheduled before any body code).
    if (ui.root && !ui.root.isConnected) {
      try { document.documentElement.appendChild(ui.root); } catch {}
    }

    // The instability warning floats just ABOVE the bar, so it never crowds the row on narrow composers.
    placeUnstable();

    const mount = computeBarMount();
    const anchorEl = (provider.barAnchor && provider.barAnchor()) || null;
    const mode = chooseBarMode({
      // A bot check or a blocking modal (login / consent) is up: the (often transparent) full-width bar
      // would silently intercept clicks on its buttons, so get out of the way until it clears.
      obstructed: !!((provider.captchaPresent && provider.captchaPresent()) || (provider.overlayBlocking && provider.overlayBlocking())),
      hasInlineMount: !!mount,
      hasAnchor: !!(anchorEl && anchorEl.isConnected),
    });
    if (mode === "hidden") hideBar();
    else if (mode === "inline") seatInline(mount);
    else if (mode === "anchored") seatAnchored(anchorEl);
    else seatFloating();
  }

  return { place };
}
