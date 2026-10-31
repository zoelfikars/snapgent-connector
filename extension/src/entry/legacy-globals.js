// SPDX-License-Identifier: GPL-3.0-or-later
// Bridges the pure domain layer to the not-yet-migrated content scripts, which
// still read these as globals. Shrinks as legacy code moves behind modules.
import * as domain from "../domain/index.js";
import { bareToolName } from "../domain/tools/names.js";
import { AgentLoop, MessageSender, PromptResender, ResponseWatcher, SessionStarter, SkillsService, SysTally, ToolCatalogue, ToolReminder, ToolRunner } from "../application/index.js";
import { SKILL_MAX_BYTES } from "../domain/skills/skill-text.js";
import { countSinceLastMarker } from "../domain/prompt/resend.js";
import { feedbackIsError } from "../domain/tools/result-summary.js";

const { parser, ...prompt } = domain;
globalThis.ZSParse = parser;
globalThis.ZS = prompt;
globalThis.ZSApp = { AgentLoop, MessageSender, PromptResender, ResponseWatcher, SessionStarter, SkillsService, SysTally, ToolCatalogue, ToolReminder, ToolRunner };
globalThis.ZSDomain = { SKILL_MAX_BYTES, bareToolName, countSinceLastMarker, feedbackIsError };

// Shared chat-adapter primitives (see infrastructure/chat/). Adapters load after this script.
import { computeBarView } from "../ui/bar-view.js";
import { createConfirmDialog } from "../ui/confirm-dialog.js";
import { createNotifications } from "../ui/notifications.js";
import { openMcpSettings } from "../ui/mcp-settings.js";
import { openSkillsSettings } from "../ui/skills-settings.js";
import { paintChip } from "../ui/chip-view.js";
import * as chat from "../infrastructure/chat/index.js";
globalThis.ZSChat = chat;

globalThis.ZSUi = { computeBarView, createConfirmDialog, createNotifications, openMcpSettings, openSkillsSettings, paintChip };
