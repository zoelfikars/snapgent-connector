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

export {};
