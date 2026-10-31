// SPDX-License-Identifier: GPL-3.0-or-later
// Classifies a FINISHED assistant reply: a runnable command, a broken command the
// model should rewrite, a length-truncated reply, or a plain answer. Pure: it never
// touches the page, it returns what to do plus diagnostics to log.

import {
  DSML_RE, START_M, hasOpenToolBlock, hasToolSignature, parseToolCalls, salvageCutOff, toolNameFromText,
} from "../parser/index.js";

// Argument keys that appear only in a tool's raw arguments, never in ordinary prose.
const RAW_ARGUMENT_KEYS_RE = /"(?:edits|old_text|new_text)"\s*:/;
const HAS_COMMAND_KEY_RE = /"command"\s*:/;
// The model named a REAL tool but under the wrong key, the way a function-calling API would.
const WRONG_KEY_RE = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/;

/** True when `reply` already looks like a command (or its raw arguments). */
export const looksLikeCommand = (reply) =>
  hasToolSignature(reply) || (RAW_ARGUMENT_KEYS_RE.test(reply) && !HAS_COMMAND_KEY_RE.test(reply));

/**
 * @param {string} reply  the settled reply text
 * @param {{ item: object, hasContinueButton: () => boolean, knowsTool: (name: string) => boolean, catalogueSize: number }} ctx
 * @returns {{ result: object, diags: Array<[string, object]> }}
 */
export function classifyReply(reply, { item, hasContinueButton, knowsTool, catalogueSize }) {
  const diags = [];
  const done = (result) => ({ result, diags });
  const parseError = (reason) => done({ kind: "parse_error", reason, raw: reply, item });

  if (hasToolSignature(reply)) {
    const calls = parseToolCalls(reply);
    if (calls.length) return done({ kind: "tool", calls, item });
    // A half-written command plus the site's Continue button means it was truncated: resume, don't report bad JSON.
    if (hasContinueButton()) return done({ kind: "truncated", text: reply, item });
    if (reply.includes(START_M)) return parseError("malformed");
    // An opener with no closer. If only the trailing closers were lost (the model hit its output
    // limit with the payload complete) auto-close and run it; salvageCutOff refuses a cut that
    // amputated real content, which falls through to the rewrite request.
    if (hasOpenToolBlock(reply)) {
      const saved = salvageCutOff(reply);
      if (saved) {
        diags.push(["tool.salvaged", { name: saved.tool }]);
        return { result: { kind: "tool", calls: [saved], item }, diags };
      }
      return parseError("unclosed");
    }
    // A closed-looking envelope that NAMES A REAL TOOL but failed to parse (an unescaped quote broke
    // the JSON). Gated on a known name so prose that merely quotes {"command": "..."} is not looped on.
    const name = toolNameFromText(reply);
    if (name && name !== "command" && knowsTool(name)) return parseError("malformed");
  }

  // The model answered in its OWN native markup (DeepSeek's DSML). Unambiguous, so no known-tool gate:
  // the degenerate form carries no tool name at all.
  if (DSML_RE.test(reply)) {
    diags.push(["cmd.dsml", { len: reply.length }]);
    return parseError("dsml");
  }
  // A tool's raw arguments as a bare JSON object, without the {"command":..., "params":...} envelope.
  if (RAW_ARGUMENT_KEYS_RE.test(reply) && !HAS_COMMAND_KEY_RE.test(reply)) return parseError("envelope");

  const wrongKey = WRONG_KEY_RE.exec(reply);
  if (wrongKey && !HAS_COMMAND_KEY_RE.test(reply)) {
    const known = knowsTool(wrongKey[1]);
    // Log the miss too: the gate depends on how the bridge advertises names, so a silent no-match is undiagnosable.
    diags.push(["cmd.wrongKey", { name: wrongKey[1], known, catalogue: catalogueSize }]);
    if (known) return parseError("toolKey");
  }

  // A "server busy" notice is deliberately a plain answer: retrying risked an endless re-answer loop.
  if (hasContinueButton()) return done({ kind: "truncated", text: reply, item });
  if (reply === "") {
    diags.push(["empty.why", { branch: "finalBlank" }]);
    return done({ kind: "empty" });
  }
  return done({ kind: "text", text: reply });
}
