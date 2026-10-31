// SPDX-License-Identifier: GPL-3.0-or-later
// The "Agent is working…" cover laid over the composer while the agent runs, so the user cannot type into a box the
// agent is about to fill. Where it goes and how large is cover-geometry.js, its colour cover-color.js; this keeps it
// glued to the live editor node frame by frame, and out of the way of a login or bot-check overlay.

import { boxOf, computeCoverRect, measureClippingAncestors } from "./cover-geometry.js";
import { opaqueBg } from "./cover-color.js";

/**
 * @param {{ document: Document, provider: object }} deps  the window comes from `document.defaultView`
 * @returns {{ set: (on: boolean) => void }}
 */
export function createInputCover({ document, provider }) {
  const win = document.defaultView;
  let cover = null;
  let coverRaf = 0;

  function set(on) {
    const ed = provider.getEditor();
    if (!on) {
      if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
      if (ed) ed.classList.remove("zs-typing");
      win.cancelAnimationFrame(coverRaf);
      return;
    }
    if (!ed) return;
    ed.classList.add("zs-typing"); // make the typed text itself invisible
    if (!cover) {
      cover = document.createElement("div");
      cover.id = "zs-input-cover";
      cover.innerHTML = `<span>Agent is working…</span>`;
      document.documentElement.appendChild(cover);
    }
    cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
    cover.style.display = "flex";
    const place = () => {
      // Loop runs while the cover is INTENDED on (dataset.on), not while it's
      // visible - so we can hide it for an overlay and still restore it after.
      if (!cover || cover.dataset.on !== "1") return;
      const e = provider.getEditor();
      if (!e) { coverRaf = win.requestAnimationFrame(place); return; }
      // Re-assert the typing mask on the CURRENT editor node: sites that
      // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
      // which would un-hide the raw text and un-cap its height. Cheap idempotent
      // add every frame keeps the mask + height cap glued to the live node.
      if (!e.classList.contains("zs-typing")) e.classList.add("zs-typing");
      // The cover is SIZED to coverTarget() when a provider supplies one, else
      // to the editor node itself. Some composers (Meta AI) make the editable a
      // tiny line inside a much larger rounded card - covering only the editor
      // left the rest of the card exposed and CLICKABLE (a careful click focused
      // the editor and let the user type behind the cover). Meta returns its
      // whole composer card so the cover blankets the entire input band and its
      // pointer-events:auto blocks every click. The typing mask above still lives
      // on the real editor node `e`.
      const covNode = (provider.coverTarget && provider.coverTarget()) || e;
      // While a blocking modal (login / consent) or bot-check is up, hide the
      // cover so it doesn't sit on top of the modal; it reappears once the
      // overlay clears (the loop keeps running).
      if (
        (provider.overlayBlocking && provider.overlayBlocking()) ||
        (provider.captchaPresent && provider.captchaPresent())
      ) {
        cover.style.display = "none";
        coverRaf = win.requestAnimationFrame(place);
        return;
      }
      cover.style.display = "flex";
      // All the placement rules (clip to the visible band, stay inside the composer card, pad, minimum
      // and maximum height) are in src/ui/cover-geometry.js; this only measures the page.
      const frame = provider.composerFrame && provider.composerFrame();
      const rect = computeCoverRect({
        target: boxOf(covNode.getBoundingClientRect()),
        ancestors: measureClippingAncestors(covNode, document, win.getComputedStyle),
        frame: frame ? boxOf(frame.getBoundingClientRect()) : null,
        pad: provider.coverPad || 0, // some composers (Gemini's Quill) keep text near rounded corners
        offsetY: provider.coverOffsetY || 0,
        maxHeight: provider.coverMaxH || 200,
      });
      cover.style.left = rect.left + "px";
      cover.style.top = rect.top + "px";
      cover.style.width = rect.width + "px";
      cover.style.height = rect.height + "px";
      // Composite the surface BEHIND the cover target so the fill matches what
      // the user sees (a translucent composer card blends over the page).
      cover.style.background = opaqueBg(document, covNode);
      // When the cover blankets a whole composer card (coverTarget), match its
      // corner radius so the cover's square corners don't poke past the card's
      // rounded ones. Editor-sized covers keep the CSS default.
      if (provider.coverTarget) cover.style.borderRadius = win.getComputedStyle(covNode).borderRadius;
      coverRaf = win.requestAnimationFrame(place);
    };
    place();
  }

  return { set };
}
