// SPDX-License-Identifier: GPL-3.0-or-later
// Turns a raw bridge result into the text the model reads back. Pure.

import { FEEDBACK } from "../prompt/feedback.js";
import { bareToolName } from "./names.js";

// An MCP server may report a missing/invalid parameter as a SUCCESS whose text is
// just the complaint (e.g. "path is required"). Treat that as the error it is.
// The sentence that tells the model an image rides on this message. The page recognises image results
// after a reload by this exact phrase, so the two must never drift apart (see IMAGE_FEEDBACK_RE).
const IMAGE_NOTE = "image is attached to THIS message";
export const IMAGE_FEEDBACK_RE = new RegExp(IMAGE_NOTE, "i");

const PARAM_COMPLAINT_RE = /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i;

/**
 * @typedef {{ ok?: boolean, text?: string, images?: object[], kind?: string, error?: string }} BridgeResult
 * @returns {{ text: string, images?: object[], event?: "stale-extension" }}
 */
export function toFeedback(result, { name, supportsVision, timeoutSeconds = 120 }) {
  if (!result) return { text: FEEDBACK.bridgeOffline };

  if (result.ok) {
    const body = result.text && result.text.trim();
    if (body && PARAM_COMPLAINT_RE.test(body)) {
      return { text: `ERROR calling '${name}': ${body}.\nA required or invalid parameter - check the command's parameters with list_commands, fix the call and retry.` };
    }
    const images = result.images && result.images.length ? result.images : null;
    if (images && !supportsVision) {
      // Any tool can turn out to return images; refuse cleanly rather than attach a
      // file this provider's model will never process.
      return { text: `ERROR: '${bareToolName(name)}' returned an image, but this assistant cannot see images. Do NOT call it again. Use a different command to get the information as text instead.` };
    }
    if (images) {
      const caption = body || `${images.length} image(s) captured.`;
      return {
        text: `Output of '${name}':\n${caption}\n(The ${IMAGE_NOTE} - you can see it directly. Analyse it and continue.)`,
        images,
      };
    }
    return { text: `Output of '${name}':\n${result.text && result.text.length ? result.text : "(tool returned an empty result)"}` };
  }

  // A page reload is the only cure for an orphaned content script: say exactly that.
  if (result.kind === "stale-extension") return { text: FEEDBACK.staleExtension, event: "stale-extension" };
  if (result.kind === "disconnected") return { text: FEEDBACK.bridgeOffline };
  if (result.kind === "timeout") {
    return { text: `ERROR: tool '${name}' timed out after ${timeoutSeconds}s.\n${result.error}\nTry a shorter/simpler call.` };
  }
  return { text: `ERROR calling '${name}': ${result.error}\nRead the error carefully, fix the call or try a different approach.` };
}
