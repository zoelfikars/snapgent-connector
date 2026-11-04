// SPDX-License-Identifier: GPL-3.0-or-later
// The menu behind the "switch AI" pill: shortcuts to the other chat sites, the MCP and skills settings, where the bar sits, and the
// calibration of this site.

import { SKILL_MAX_BYTES } from "../domain/skills/skill-text.js";
import { SITE_LINKS } from "../sites/registry.js";
import { openMcpSettings, openPreferences, openSkillsSettings, switchMenuHtml } from "../ui/index.js";

/**
 * @param {{ document: Document, window: Window, menu: HTMLElement, button: HTMLElement, group: object,
 *           provider: object, settings: object, serverDirectory: object, skills: object, calibration: object,
 *           barPrefs: { get: () => object, set: (change: object) => void }, preferences: object, refreshTarget: () => void }} deps
 * @returns {{ toggle: (toSupport: boolean) => void, close: () => void, isOpen: () => boolean }}
 */
export function createSiteMenu({ document, window, menu, button, group, provider, settings, serverDirectory, skills, calibration, barPrefs, preferences, refreshTarget }) {
  const close = () => { menu.hidden = true; };
  group.add({ close });

  function openMcp() {
    const servers = serverDirectory.servers();
    openMcpSettings({
      document,
      options: serverDirectory.allOptions().map((option) => ({ id: option.id, name: option.name, tools: (servers.find((server) => server.id === option.id) || {}).tools })),
      isEnabled: (id) => serverDirectory.isEnabled(id),
      setEnabled: (id, on) => serverDirectory.setEnabled(id, on),
      onToggle: refreshTarget, // a re-enabled server is selectable without waiting for the popup to close
      onClose: () => {
        // The target was just disabled: move to the first enabled one (which restarts the page against it).
        if (!serverDirectory.isEnabled(settings.target())) {
          const next = serverDirectory.firstEnabled();
          if (next) { settings.selectTarget(next.id); return; }
        }
        refreshTarget();
      },
    });
  }

  function fill() {
    menu.innerHTML = switchMenuHtml(SITE_LINKS, provider.displayName, { calibration: true, corner: barPrefs.get().corner });
    menu.querySelectorAll("button.zs-site-opt[data-u], .zs-tip-opt[data-u]").forEach((link) => link.addEventListener("click", () => {
      try { window.open(link.dataset.u, "_blank", "noopener"); } catch { /* popups blocked */ }
      close();
    }));
    const on = (selector, action) => {
      const el = menu.querySelector(selector);
      if (el) el.addEventListener("click", (event) => { event.stopPropagation(); close(); action(); });
    };
    on("#zs-mcp-settings", openMcp);
    on("#zs-prefs", async () => openPreferences({
      document, values: await preferences.read(), defaults: { folders: preferences.defaultFolders() },
      save: { chars: preferences.setChars, calls: preferences.setCalls, folders: preferences.setFolders },
    }));
    on("#zs-skills-settings", () => openSkillsSettings({ document, skills, maxFileBytes: SKILL_MAX_BYTES, loadOnOpen: settings.target() === "vscode" }));
    on("#zs-bar-corner", () => barPrefs.set({ corner: barPrefs.get().corner === "top" ? "bottom" : "top" }));
    on("#zs-bar-hide", () => barPrefs.set({ hidden: true }));
    on("#zs-cal-start", () => calibration.open(null));
    on("#zs-cal-export", calibration.exportProfile);
    on("#zs-cal-import", calibration.importProfile);
    on("#zs-cal-diag", calibration.copyDiagnostics);
    on("#zs-cal-remove", calibration.remove);
    on("#zs-cal-export-all", calibration.exportAll);
    on("#zs-cal-import-all", calibration.importAll);
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
