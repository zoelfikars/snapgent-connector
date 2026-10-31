// SPDX-License-Identifier: GPL-3.0-or-later
// Bridges the pure domain layer to the not-yet-migrated content scripts, which
// still read these as globals. Shrinks as legacy code moves behind modules.
import * as domain from "../domain/index.js";
import { bareToolName } from "../domain/tools/names.js";
import { AgentLoop, BridgeMonitor, MessageSender, PromptResender, ProfileStore, ResponseWatcher, ServerDirectory, SessionStarter, SessionTracker, SkillsService, SysTally, ToolCatalogue, ToolReminder, ToolRunner, TurnMemory, textShowsSession } from "../application/index.js";
import { SKILL_MAX_BYTES } from "../domain/skills/skill-text.js";
import { countSinceLastMarker } from "../domain/prompt/resend.js";
import { feedbackIsError } from "../domain/tools/result-summary.js";

const { parser, ...prompt } = domain;
globalThis.ZSParse = parser;
globalThis.ZS = prompt;
globalThis.ZSApp = { AgentLoop, BridgeMonitor, MessageSender, PromptResender, ProfileStore, ResponseWatcher, ServerDirectory, SessionStarter, SessionTracker, SkillsService, SysTally, ToolCatalogue, ToolReminder, ToolRunner, TurnMemory, textShowsSession };
globalThis.ZSDomain = { SKILL_MAX_BYTES, bareToolName, countSinceLastMarker, feedbackIsError };

// Shared chat-adapter primitives (see infrastructure/chat/). Adapters load after this script.
import * as ui from "../ui/index.js";
import * as chat from "../infrastructure/chat/index.js";
import { siteFor } from "../sites/registry.js";
import { createCalibratedProvider, learnProfile, profileProblems, updateProfile } from "../infrastructure/calibration/index.js";
globalThis.ZSChat = chat;
globalThis.ZSSites = { siteFor };
globalThis.ZSCalibration = { createCalibratedProvider, learnProfile, profileProblems, updateProfile };

globalThis.ZSUi = ui;
