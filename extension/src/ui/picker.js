// SPDX-License-Identifier: GPL-3.0-or-later
// "Click the element": while it runs the page does not receive the user's clicks, the element under the pointer is
// reported as it changes, and one genuine click chooses it. A click a page script fabricated (not `isTrusted`) is
// swallowed and chooses nothing, so a page cannot pick elements on the user's behalf.

const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick", "dblclick", "contextmenu"];

/**
 * @param {{ document: Document, trusted?: (event: Event) => boolean }} deps
 * @returns {{ start: (options: { ignore?: Element|((target: Element) => boolean)|null, refine?: (el: Element) => Element, onHover?: (el: Element|null) => void,
 *                                 onPick: (el: Element) => void, onCancel?: () => void }) => () => void }}
 */
export function createPicker({ document, trusted = (event) => event.isTrusted }) {
  function start({ ignore = null, refine = (el) => el, onHover = () => {}, onPick, onCancel = () => {} }) {
    const targetOf = (event) => {
      const first = event.composedPath ? event.composedPath()[0] : null;
      return first && first.nodeType === 1 ? first : event.target;
    };
    // Events from inside our own panel keep working; a closed shadow root shows up as its host.
    const ours = (event) => {
      if (!ignore) return false;
      if (typeof ignore === "function") return !!ignore(event.target);
      return event.target === ignore || ignore.contains(event.target);
    };
    const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };

    const onMove = (event) => {
      if (ours(event)) return onHover(null);
      const el = targetOf(event);
      onHover(el && el.nodeType === 1 ? refine(el) : null);
    };
    const onClick = (event) => {
      if (ours(event)) return;
      swallow(event);
      if (!trusted(event)) return;
      const el = targetOf(event);
      if (el && el.nodeType === 1) onPick(refine(el));
    };
    const onBlocked = (event) => { if (!ours(event)) swallow(event); };
    const onKey = (event) => {
      if (event.key !== "Escape" || !trusted(event)) return;
      swallow(event);
      onCancel();
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    for (const type of BLOCKED) document.addEventListener(type, onBlocked, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      for (const type of BLOCKED) document.removeEventListener(type, onBlocked, true);
      onHover(null);
    };
  }
  return { start };
}
