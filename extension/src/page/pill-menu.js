// SPDX-License-Identifier: GPL-3.0-or-later
// A dropdown that opens beside a pill of the bar. All of them behave the same: one open at a time, a click outside closes it, and
// it is re-placed every frame while open (its content, and the page around it, may change size).

import { applyMenuPlacement, computeMenuPlacement, viewportOf } from "../ui/index.js";

/** Menus that must not be open together. */
export function createMenuGroup() {
  const members = new Set();
  return { add: (member) => members.add(member), closeAll: () => members.forEach((member) => member.close()) };
}

/**
 * @param {{ document: Document, button: HTMLElement, menu: HTMLElement, group: object, width: number, align: "left"|"right",
 *           roomAbove: number, render?: () => (void|false|Promise<void|false>) }} options
 *   `render` fills the menu when it opens; returning `false` cancels the opening.
 */
export function createPillMenu({ document, button, menu, group, width, align, roomAbove, render }) {
  const win = document.defaultView;
  const place = () => applyMenuPlacement(menu, computeMenuPlacement({
    anchor: button.getBoundingClientRect(), menuWidth: menu.offsetWidth, defaultWidth: width, viewport: viewportOf(document, win), align, roomAbove,
  }));
  const follow = () => { if (menu.hidden) return; place(); win.requestAnimationFrame(follow); };

  const self = {
    get isOpen() { return !menu.hidden; },
    close() { menu.hidden = true; },
    async open() {
      group.closeAll();
      menu.hidden = false;
      if (render && (await render()) === false) { menu.hidden = true; return; }
      win.requestAnimationFrame(follow);
    },
    toggle() { return menu.hidden ? self.open() : self.close(); },
    /** Redraw the content of an open menu. */
    refresh() { return render && render(); },
  };
  group.add(self);
  button.addEventListener("click", (event) => { event.stopPropagation(); self.toggle(); });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) self.close();
  }, true);
  return self;
}
