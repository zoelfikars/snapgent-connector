// SPDX-License-Identifier: GPL-3.0-or-later
// The settings buttons of the bar: Skills, MCP servers and Preferences. Split from bar.js so each module stays small, and so the
// Files window can open the very same Preferences dialog.

import { SKILL_MAX_BYTES } from "../domain/skills/skill-text.js";
import { openMcpSettings, openPreferences, openSkillsSettings, openTutorial } from "../ui/index.js";
import { TUTORIAL_IMAGES, TUTORIAL_MARKDOWN } from "./tutorial-content.js";

/**
 * @param {{ document: Document, root: HTMLElement, settings: object, serverDirectory: object, tools: object, preferences: object,
 *           calibration: object, barPrefs: { get: () => object, set: (change: object) => void }, isWorkspaceTarget: () => boolean,
 *           syncMenus: () => void }} deps
 * @returns {{ openPreferences: () => Promise<void> }} the Preferences dialog, usable from other parts of the bar
 */
export function createBarSettings({ document, root, settings, serverDirectory, tools, preferences, calibration, barPrefs, isWorkspaceTarget, syncMenus }) {
  const $ = (selector) => root.querySelector(selector);

  const actions = () => ({
    onToggleCorner: () => barPrefs.set({ corner: barPrefs.get().corner === "top" ? "bottom" : "top" }),
    onHideBar: () => barPrefs.set({ hidden: true }),
    onCalibrate: () => calibration.open(null),
    onExportCal: calibration.exportProfile,
    onImportCal: calibration.importProfile,
    onCopyDiag: calibration.copyDiagnostics,
    onRemoveCal: calibration.remove,
    onExportAll: calibration.exportAll,
    onImportAll: calibration.importAll,
    onCopyTest: calibration.copyTestText,
    onFillTest: calibration.fillTestText,
    onFillStartMessage: calibration.fillStartMessage,
    onFillReminder: calibration.fillReminderMessage,
    onAttachTest: calibration.attachTestFile,
  });

  async function openPreferencesDialog() {
    openPreferences({
      document, values: { ...(await preferences.read()), site: calibration.limits() }, defaults: { folders: preferences.defaultFolders(), contextFiles: preferences.defaultContextFiles() },
      save: { chars: preferences.setChars, calls: preferences.setCalls, folders: preferences.setFolders, contextFiles: preferences.setContextFiles, asFile: preferences.setAsFile, site: calibration.setLimits },
      corner: barPrefs.get().corner, actions: actions(),
    });
  }

  $("#zs-skills-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openSkillsSettings({ document, skills: tools.skills, maxFileBytes: SKILL_MAX_BYTES, loadOnOpen: isWorkspaceTarget() });
  });

  $("#zs-mcp-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const servers = serverDirectory.servers();
    openMcpSettings({
      document,
      options: serverDirectory.allOptions().map((option) => ({ id: option.id, name: option.name, tools: (servers.find((server) => server.id === option.id) || {}).tools })),
      isEnabled: (id) => serverDirectory.isEnabled(id),
      setEnabled: (id, on) => serverDirectory.setEnabled(id, on),
      onToggle: syncMenus,
      onClose: () => {
        if (!serverDirectory.isEnabled(settings.target())) {
          const next = serverDirectory.firstEnabled();
          if (next) { settings.selectTarget(next.id); return; }
        }
        syncMenus();
      },
    });
  });

  $("#zs-info-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openTutorial({ document, markdown: TUTORIAL_MARKDOWN, images: TUTORIAL_IMAGES });
  });

  $("#zs-prefs-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openPreferencesDialog();
  });

  return { openPreferences: openPreferencesDialog };
}
