// SPDX-License-Identifier: GPL-3.0-or-later
// Everything the page code (src/page) may use from the UI layer, in one place.
export { computeBarView } from "./bar-view.js";
export { createConfirmDialog } from "./confirm-dialog.js";
export { createNotifications } from "./notifications.js";
export { openMcpSettings } from "./mcp-settings.js";
export { openSkillsSettings } from "./skills-settings.js";
export { applyTheme } from "./page-theme.js";
export { computeMenuPlacement, applyMenuPlacement, viewportOf } from "./menu-position.js";
export { createSetupCard, shouldShowSetup } from "./setup-card.js";
export { APPROVAL_MODES, atPopupHtml, fileRowsHtml, filesMenuHtml, modeMenuHtml, switchMenuHtml, targetMenuHtml, workspaceLabel, workspaceMenuHtml } from "./menu-html.js";
export { createBarPlacer } from "./bar-placer.js";
export { createInputCover } from "./input-cover.js";
export { createCalibrationWizard } from "./calibration-wizard.js";
export { createPicker } from "./picker.js";
export { pillHtml } from "./pill.js";
