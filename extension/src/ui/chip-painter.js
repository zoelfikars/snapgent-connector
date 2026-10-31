// SPDX-License-Identifier: GPL-3.0-or-later
// Paints a tool chip into a chat turn and keeps it where the site cannot wipe it: placement relative to the turn
// (inside, at the turn root, or anchored by the adapter), hiding the raw command block, and rebuilding a chip the
// site re-rendered away. What the chip SAYS is decided elsewhere (command-phase.js, turn-chips.js); how it is
// drawn is chip-view.js. The adapter supplies the site-specific bits (findToolBlockSpot, chipAnchor, ...).

import { hasCommandShape } from "../domain/parser/index.js";
import { toolCategory } from "../domain/tools/category.js";
import { paintChip } from "./chip-view.js";

/**
 * @param {{ document: Document, provider: object, diag?: (event: string, data?: object) => void }} deps
 * @returns {{ chip: Function, ensureOwnedChip: Function, toolBox: Function }}
 */
export function createChipPainter({ document, provider, diag = () => {} }) {
  // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
  function chip(item, opts) {
    const { cls, whole } = opts;
    // Drawing lives in ui/chip-view.js (paintChip). It rebuilds the inner markup only when the
    // signature changes, so the streaming spinner keeps animating. Re-anchoring + masking below
    // still run on every pass.
    const painted = paintChip(document, item.querySelector(".zs-chip"), opts);

    if (whole) {
      // Fully injected turn (result / sys) → hide the whole item.
      if (painted.parentElement !== item) item.insertBefore(painted, item.firstChild);
      item.classList.add("zs-hidden");
    } else {
      item.classList.remove("zs-hidden");
      // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
      // we call it for that even when we don't use its returned position.
      const spot = provider.findToolBlockSpot(item, painted);
      if (provider.chipAtItemLevel) {
        // Site re-renders the turn's content subtree (Angular/Gemini), which
        // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
        // level instead, where it survives those re-renders; the hide classes
        // (re-applied by the sweep) handle masking the raw block.
        // A provider may supply chipAnchor(item) to redirect the chip into a
        // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
        // inserting at item.firstChild would make the chip the avatar's flex
        // sibling and shove the layout sideways, so it anchors in the content
        // column instead). Default: the turn root.
        const anchor = (provider.chipAnchor && provider.chipAnchor(item)) || item;
        // Default: pin the chip as the FIRST child - simple and immune to the
        // site re-appending fresh content later. A provider may opt into
        // `chipAppend` to place it LAST instead (reads in the model's actual
        // order: narration, then the tool call it wrote at the end of the
        // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
        // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
        // when "last" - see ensureOwnedChip's drift check for why this needs
        // upkeep that firstChild pinning never did.
        const wantLast = !!provider.chipAppend;
        const trailRef = wantLast && provider.chipTrailRef ? provider.chipTrailRef(item) : null;
        const inPlace = painted.parentElement === anchor &&
          (wantLast ? painted.nextElementSibling === trailRef : anchor.firstElementChild === painted);
        if (!inPlace) {
          if (wantLast) anchor.insertBefore(painted, trailRef); // trailRef=null -> append
          else anchor.insertBefore(painted, anchor.firstChild);
        }
      } else if (spot) {
        spot.parent.insertBefore(painted, spot.ref);
      } else if (!painted.parentElement) {
        item.insertBefore(painted, item.firstChild);
      }
    }
    item.dataset.zs = cls || "1";
    // Remember the exact opts so a chip wiped by a site re-render can be
    // rebuilt identically (see ensureOwnedChip / the chipGone guards).
    item.__zsChip = { ...opts };
    return painted;
  }

  // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
  // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
  // so we rebuild from the stored opts rather than re-running classification.
  function ensureOwnedChip(item) {
    const opts = item.__zsChip;
    if (!opts) return;
    const chipEl = item.querySelector(".zs-chip");
    const chipGone = !chipEl;
    let rawVisible = false;
    if (!opts.whole) {
      // NOTE the thinking exclusion: reasoning models QUOTE the command
      // JSON in their think area, which the camouflage never hides
      // (by design) - counting those as "raw block visible" made this
      // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
      rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
        (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
               !(provider.thinkingSel && e.closest(provider.thinkingSel)) &&
               // Some sites (Arena) wrap a code block in a bare outer <pre>
               // that has no hide class of its own - the real content (and
               // the .zs-tool-hide class) live on a child wrapper instead.
               // closest() only checks ancestors, so without this the outer
               // <pre> reads as "raw command visible" FOREVER (its own
               // textContent includes the hidden child's text), causing an
               // infinite rebuild loop (~60/s, seen live on Arena).
               !e.querySelector(".zs-tool-hide") &&
               hasCommandShape(e.textContent || ""));
    }
    // A provider opted into `chipAppend` (chip trails the reply text instead
    // of pinning first) has no equivalent of firstChild's immunity to churn:
    // a site re-render can re-append fresh reply content AFTER our chip,
    // silently shoving it back above the text it was meant to trail. Catch
    // that drift too, not just an outright wipe - it's cheap (one property
    // read) and only applies to opted-in providers (Qwen).
    let drifted = false;
    if (!opts.whole && !chipGone && provider.chipAtItemLevel && provider.chipAppend) {
      const anchor = (provider.chipAnchor && provider.chipAnchor(item)) || item;
      const trailRef = provider.chipTrailRef ? provider.chipTrailRef(item) : null;
      drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
    }
    if (chipGone || rawVisible || drifted) {
      // Tracker: the site wiped a loop-owned chip (re-render/node churn).
      diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
      chip(item, opts);
    }
  }

  // owned=true → the agentic loop manages this item; the observer backs off.
  function toolBox(item, name, phase, detail, owned, body, category) {
    if (!item) return;
    // Tracker: every phase TRANSITION of a command chip, with who drove it.
    // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
    if (item.dataset.zphase !== phase) {
      diag("chip.phase", {
        name, from: item.dataset.zphase || "(new)", to: phase,
        by: owned ? "loop" : "sweep", detail: detail || "",
      });
    }
    const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
    chip(item, {
      label: name, detail: detail || "", body: body || "",
      category: category || toolCategory(name), phase, cls,
    });
    item.dataset.zphase = phase;
    if (owned) item.dataset.zloop = "1";
  }

  return { chip, ensureOwnedChip, toolBox };
}
