// SPDX-License-Identifier: GPL-3.0-or-later
// Interfaces the application layer depends on. Infrastructure implements them;
// tests implement them with in-memory fakes. Documentation only (no runtime code).

/**
 * @typedef {Object} BridgePort  Talks to the local bridge.
 * @property {() => Promise<{ tools?: object[] }>} listTools
 * @property {(request: { name: string, arguments: object, timeout: number, server: string }) => Promise<object>} callTool
 */

/**
 * @typedef {Object} SessionPort  What the runner needs to know about the current session.
 * @property {() => string} target                    Selected MCP server id.
 * @property {(id: string) => boolean} isEnabled      Is that server toggled on?
 * @property {() => Array<{id:string, alive?:boolean, tools?:number}>} servers  Bridge health per server.
 * @property {() => boolean} supportsVision           Can this chat's model see images?
 * @property {() => boolean} isStopped                Has the user pressed Stop?
 */

/**
 * @typedef {Object} VisibilityPort  Execution must not happen while the tab is hidden.
 * @property {() => boolean} isHidden
 * @property {() => Promise<boolean>} waitUntilVisible  Resolves false if stopped while waiting.
 */

/**
 * @typedef {Object} SinkPort  One-way notifications out of the runner.
 * @property {(images: object[], toolName: string) => void} images
 * @property {(error: string, toolName: string) => void} staleExtension
 * @property {(event: string, data?: object) => void} diag
 */

/**
 * @typedef {Object} Timers
 * @property {typeof setTimeout} setTimeout
 * @property {typeof clearTimeout} clearTimeout
 * @property {typeof setInterval} setInterval
 * @property {typeof clearInterval} clearInterval
 */

/**
 * @typedef {Object} ChatTurnsPort  The conversation, as the loop sees it.
 * @property {(base: *) => Promise<object>} next   Wait for the model's next reply (a classified response).
 * @property {(text: string, images?: object[]|null) => Promise<*>} submit  Send text; resolves to the new base.
 * @property {(item: object) => boolean} isHalted    Was this turn halted by a stop?
 * @property {() => Promise<boolean>} resumeTruncated  Click the site's Continue; true if generation resumed.
 */

/**
 * @typedef {Object} LoopViewPort  Everything the loop draws or announces.
 * @property {(level: string, title: string, text: string) => void} banner
 * @property {(text: string) => void} toast
 * @property {() => void} keepCover   Keep the "agent is working" cover up (e.g. while parked).
 * @property {(chip: {item: object, name: string, detail: string, category: string}) => void} parseErrorChip
 * @property {(item: object, call: object, category: string, text: {arg: string, body: string}) => void} toolRunning
 * @property {() => void} toolFinished
 * @property {(item: object, call: object, category: string) => void} toolStopped
 * @property {(item: object, call: object, outcome: object) => void} toolSettled
 */

/**
 * @typedef {Object} LoopLifecyclePort  Run-state of the loop, owned by the page.
 * @property {() => void} start   Mark running, lock input, show Stop.
 * @property {() => void} end     Undo start; always called, even after an error.
 * @property {() => boolean} isStopped
 * @property {() => void} halt    Ask the loop to stop (used by the stall watchdog).
 */

/**
 * @typedef {Object} LoopToolsPort  Tool-related state the loop reads and updates.
 * @property {() => boolean} hasCatalogue
 * @property {(bareName: string) => boolean} isImageTool
 * @property {(name: string) => void} learnImageTool
 * @property {() => boolean} hasPendingImages
 * @property {() => object[]|null} takePendingImages
 * @property {() => string} reminderText
 */

/**
 * @typedef {Object} ReplyReaderPort  Reads the assistant's reply from the chat page.
 * @property {() => boolean} isGenerating
 * @property {() => {item: object|null, reply: string, thinking?: string}} readAssistant
 * @property {() => *} [lastAssistantId]       Stable id of the last assistant turn, when the site allows it.
 * @property {() => number} assistantCount
 * @property {() => string|null} scanError     Context-limit style error text on the page, if any.
 * @property {(item: object) => boolean} turnHalted
 * @property {(text: string) => boolean} isTooLongMsg
 * @property {() => object|null} findContinueBtn
 * @property {boolean} [reliableCounts]        Turn counts can be trusted (no list virtualisation).
 * @property {(item: object) => boolean} [replyUnsettled]
 * @property {(item: object) => boolean} [isComparisonTurn]
 * @property {() => boolean} [resolveComparison]
 */

export {};
