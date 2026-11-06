// SPDX-License-Identifier: GPL-3.0-or-later
// A floating window that can be moved (the handle in its corner) and resized (the grip), the terminal's panel made reusable.
// Pure drawing: the body is the caller's, the frame, the moving and the resizing are here.

const TEMPLATE =
  '<div class="zs-fw-head"><span class="zs-fw-title"></span>' +
  '<button class="zs-fw-close" type="button" aria-label="Close">&#10005;</button></div>' +
  '<div class="zs-fw-body"></div>' +
  '<button class="zs-fw-drag" type="button" aria-label="Move this window" title="Drag to move">&#10303;</button>' +
  '<div class="zs-fw-grip" title="Drag to resize" aria-hidden="true"></div>';

const MIN_W = 320;
const MIN_H = 220;

/**
 * @param {{ document: Document, title?: string, className?: string, width?: number }} options
 *   `width` is the opening width (the height opens at the window's); the user's later moves and resizes are kept.
 * @returns {{ root: HTMLElement, body: HTMLElement, open: () => void, close: () => void, toggle: () => void,
 *             isOpen: () => boolean, setTitle: (text: string) => void }}
 */
export function createFloatingWindow({ document, title = "", className = "", width = 560 }) {
  const root = document.createElement("div");
  root.className = `zs-float-win ${className}`.trim();
  root.hidden = true;
  root.innerHTML = TEMPLATE;
  root.querySelector(".zs-fw-title").textContent = title;
  document.documentElement.appendChild(root);
  const body = root.querySelector(".zs-fw-body");
  const dragEl = root.querySelector(".zs-fw-drag");
  const gripEl = root.querySelector(".zs-fw-grip");
  root.querySelector(".zs-fw-close").addEventListener("click", () => close());

  // Moving: the handle sets left/top from the window's place, so a dragged window stays where it was dropped.
  let drag = null;
  dragEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    if (dragEl.setPointerCapture) dragEl.setPointerCapture(event.pointerId);
  });
  dragEl.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const view = document.documentElement;
    const left = Math.min(Math.max(0, drag.left + event.clientX - drag.x), Math.max(0, view.clientWidth - root.offsetWidth));
    const top = Math.min(Math.max(0, drag.top + event.clientY - drag.y), Math.max(0, view.clientHeight - root.offsetHeight));
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  });
  const endDrag = () => { drag = null; };
  dragEl.addEventListener("pointerup", endDrag);
  dragEl.addEventListener("pointercancel", endDrag);

  // Resizing: the grip at the opposite corner grows the window, never past the window's own edges.
  let size = null;
  gripEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    size = { x: event.clientX, y: event.clientY, w: rect.width, h: rect.height, left: rect.left, top: rect.top };
    if (gripEl.setPointerCapture) gripEl.setPointerCapture(event.pointerId);
  });
  gripEl.addEventListener("pointermove", (event) => {
    if (!size) return;
    const view = document.documentElement;
    const maxW = view.clientWidth - size.left;
    const maxH = view.clientHeight - size.top;
    const w = Math.min(maxW, Math.max(MIN_W, size.w + (event.clientX - size.x)));
    const h = Math.min(maxH, Math.max(MIN_H, size.h + (event.clientY - size.y)));
    root.style.width = `${Math.round(w)}px`;
    root.style.height = `${Math.round(h)}px`;
  });
  const endResize = () => { size = null; };
  gripEl.addEventListener("pointerup", endResize);
  gripEl.addEventListener("pointercancel", endResize);

  function open() {
    if (!root.hidden) return;
    if (!root.dataset.sized) {
      root.dataset.sized = "1";
      root.style.width = `${Math.min(width, document.documentElement.clientWidth - 28)}px`;
      root.style.height = `${document.documentElement.clientHeight - 28}px`;
    }
    root.hidden = false;
  }
  function close() { root.hidden = true; }
  function toggle() { root.hidden ? open() : close(); }

  return { root, body, open, close, toggle, isOpen: () => !root.hidden, setTitle: (text) => { root.querySelector(".zs-fw-title").textContent = text; } };
}
