// SPDX-License-Identifier: GPL-3.0-or-later
// Everything the page-side code (legacy/main.js) may use from the UI layer, in one place.
export { computeBarView } from "./bar-view.js";
export { createConfirmDialog } from "./confirm-dialog.js";
export { createNotifications } from "./notifications.js";
export { openMcpSettings } from "./mcp-settings.js";
export { openSkillsSettings } from "./skills-settings.js";
export { paintChip } from "./chip-view.js";
export { applyTheme } from "./page-theme.js";
export { opaqueBg } from "./cover-color.js";
export { computeMenuPlacement, applyMenuPlacement, viewportOf } from "./menu-position.js";
export { createSetupCard, shouldShowSetup } from "./setup-card.js";
export { computeCoverRect, measureClippingAncestors, boxOf } from "./cover-geometry.js";
export { anchoredGeometry, chooseBarMode, floatingGeometry, pillPosition } from "./bar-placement.js";
export { describeResultTurn, describeSystemTurn } from "./turn-chips.js";
export { commandPhase, haltState, holdsRegenerateLook, shouldReown } from "./command-phase.js";
export { switchMenuHtml, targetMenuHtml, targetOptionsHtml } from "./menu-html.js";
export { createChipPainter } from "./chip-painter.js";
