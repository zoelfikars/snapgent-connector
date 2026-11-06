// SPDX-License-Identifier: GPL-3.0-or-later
// Everything the page code (src/page) may use from the UI layer, in one place.
export { computeBarView } from "./bar-view.js";
export { createConfirmDialog } from "./confirm-dialog.js";
export { createChoiceDialog } from "./choice-dialog.js";
export { createNotifications } from "./notifications.js";
export { openMcpSettings } from "./mcp-settings.js";
export { openCalibrationImport } from "./calibration-import.js";
export { openSkillsSettings } from "./skills-settings.js";
export { openPreferences } from "./preferences-popup.js";
export { applyTheme } from "./page-theme.js";
export { computeMenuPlacement, applyMenuPlacement, viewportOf } from "./menu-position.js";
export { createSetupCard, shouldShowSetup } from "./setup-card.js";
export { APPROVAL_MODES, atPopupHtml, fileRowsHtml, filesMenuHtml, modeMenuHtml, switchMenuHtml, targetMenuHtml, workspaceLabel, workspaceMenuHtml } from "./menu-html.js";
export { buildFileTree } from "../domain/prompt/file-tags.js";
export { createBarPlacer } from "./bar-placer.js";
export { createInputCover } from "./input-cover.js";
export { createTerminalPanel } from "./terminal-panel.js";
export { createFloatingWindow } from "./floating-window.js";
export { classesOf, feed, lineHtml, segmentHtml } from "./ansi.js";
export { createCalibrationWizard } from "./calibration-wizard.js";
export { createPicker } from "./picker.js";
export { pillHtml } from "./pill.js";
