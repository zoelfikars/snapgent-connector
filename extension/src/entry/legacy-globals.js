// SPDX-License-Identifier: GPL-3.0-or-later
// Bridges the pure domain layer to the not-yet-migrated content scripts, which
// still read these as globals. Shrinks as legacy code moves behind modules.
import * as domain from "../domain/index.js";
import { bareToolName } from "../domain/tools/names.js";
import { AgentLoop, PromptResender, ResponseWatcher, SysTally, ToolCatalogue, ToolReminder, ToolRunner } from "../application/index.js";
import { countSinceLastMarker } from "../domain/prompt/resend.js";
import { feedbackIsError } from "../domain/tools/result-summary.js";

const { parser, ...prompt } = domain;
globalThis.ZSParse = parser;
globalThis.ZS = prompt;
globalThis.ZSApp = { AgentLoop, PromptResender, ResponseWatcher, SysTally, ToolCatalogue, ToolReminder, ToolRunner };
globalThis.ZSDomain = { bareToolName, countSinceLastMarker, feedbackIsError };

// Shared chat-adapter primitives (see infrastructure/chat/). Adapters load after this script.
import * as chat from "../infrastructure/chat/index.js";
globalThis.ZSChat = chat;
