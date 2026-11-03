// SPDX-License-Identifier: GPL-3.0-or-later
// Executes one command from the model and returns the text to send back.
// It always returns a string: the model must ALWAYS receive an output.
//
// Order of decisions (each delegated to a focused module):
//   1. not while the tab is hidden             -> VisibilityPort
//   2. commands we answer ourselves            -> domain/tools/virtual-commands
//   3. is this server allowed / is the tool real -> domain/tools/isolation + ToolCatalogue
//   4. call the bridge under guards            -> call-guard
//      (a risky action first needs the user's approval -> ConfirmPort)
//   5. shape the result for the model          -> domain/tools/result-feedback

import { FEEDBACK } from "../domain/prompt/feedback.js";
import { JOB_ARGUMENT, JOB_OP_ARGUMENT, MODE_ARGUMENT, RESERVED_ARGUMENT, declinedFeedback, needsApproval, unavailableFeedback, withoutReserved } from "../domain/tools/confirmation.js";
import { isolationError } from "../domain/tools/isolation.js";
import { toFeedback } from "../domain/tools/result-feedback.js";
import { LIST_SERVERS, isListCommands, renderCommandList, renderServerList } from "../domain/tools/virtual-commands.js";
import { bareToolName } from "../domain/tools/names.js";
import { callWithGuards } from "./call-guard.js";

const DEFAULT_TIMEOUT_MS = 120000;
// The size parameters a tool may advertise (read_files, run_command / run_project_script / run_tests, get_command_output).
const OUTPUT_LIMIT_ARGUMENTS = ["max_total_chars", "max_output_chars", "max_chars"];
const STOPPED_BEFORE_RUN = "ERROR: the command was not run - stopped by the user.";

export class ToolRunner {
  /**
   * @param {{ bridge: import("./ports.js").BridgePort,
   *           catalogue: import("./tool-catalogue.js").ToolCatalogue,
   *           session: import("./ports.js").SessionPort,
   *           visibility: import("./ports.js").VisibilityPort,
   *           sink: import("./ports.js").SinkPort,
   *           confirm?: import("./ports.js").ConfirmPort,
   *           approvalMode?: () => string,
   *           timers?: import("./ports.js").Timers,
   *           timeoutMs?: number }} deps
   */
  constructor({ bridge, catalogue, session, visibility, sink, confirm = null, approvalMode = () => "manual", timers = globalThis, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this._bridge = bridge;
    this._catalogue = catalogue;
    this._session = session;
    this._visibility = visibility;
    this._sink = sink;
    this._confirm = confirm;
    this._approvalMode = approvalMode;
    this._timers = timers;
    this._timeoutMs = timeoutMs;
  }

  /**
   * @param {{ tool: string, arguments?: object }} call
   * @param {{ budgetChars?: number, jobKey?: string }} [options]  the most output the model may be sent for this call;
   *   the name the VS Code server knows the call by (the same call again is answered, not run twice; Stop cancels it)
   */
  async run(call, { budgetChars, jobKey } = {}) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return FEEDBACK.parseError("malformed");

    // This is the single choke point for ALL execution, so it is also where we
    // refuse to run blind while the tab is in the background.
    if (this._visibility.isHidden() && !this._session.isStopped()) {
      this._sink.diag("tool.waitVisible", { name });
      if (!(await this._visibility.waitUntilVisible()) || this._session.isStopped()) return STOPPED_BEFORE_RUN;
    }

    const target = this._session.target();
    if (name === LIST_SERVERS) return this._listServers(target);
    if (isListCommands(name)) return this._listCommands(name, target, args);

    const refusal = isolationError({ name, target, targetEnabled: this._session.isEnabled(target) });
    if (refusal) return refusal;
    if (!this._catalogue.names().size) await this._catalogue.ensure();
    if (!this._catalogue.knows(name)) return FEEDBACK.unknownTool(name, [...this._catalogue.names()]);

    return this._execute(name, this._withBudget(name, withoutReserved(args), budgetChars), target, jobKey);
  }

  /**
   * Hand the call's share of the message to the tool, when the tool can limit its own output (it then reads or keeps
   * only what fits, and says what it left out). A smaller limit the model chose itself is kept.
   */
  _withBudget(name, args, budgetChars) {
    if (!Number.isFinite(budgetChars) || budgetChars <= 0) return args;
    const advertised = this._catalogue.all.find((tool) => bareToolName(tool.name) === bareToolName(name));
    const properties = (advertised && advertised.inputSchema && advertised.inputSchema.properties) || {};
    const limited = { ...args };
    for (const key of OUTPUT_LIMIT_ARGUMENTS) {
      if (!(key in properties)) continue;
      const own = Number(limited[key]);
      limited[key] = Number.isFinite(own) && own > 0 ? Math.min(own, budgetChars) : budgetChars;
    }
    return limited;
  }

  async _listServers(target) {
    await this._catalogue.ensure();
    // The model only ever sees the selected server, and only if its toggle is on.
    const servers = this._session.servers().filter((sv) => sv.id === target && this._session.isEnabled(sv.id));
    return renderServerList({ servers, target });
  }

  async _listCommands(name, target, args) {
    await this._catalogue.ensure();
    return renderCommandList({
      name,
      target,
      asked: typeof args.server === "string" ? args.server.trim() : "",
      enabled: this._session.isEnabled(target),
      tools: this._catalogue.all,
    });
  }

  _callBridge(name, args, target, jobKey) {
    // The VS Code server applies the bar's choice (plan / manual / auto) and keeps the call under its job key; other servers know nothing of either.
    const sent = target === "vscode" ? { ...args, [MODE_ARGUMENT]: this._approvalMode(), ...(jobKey ? { [JOB_ARGUMENT]: jobKey } : {}) } : args;
    return callWithGuards(
      () => this._bridge.callTool({ name, arguments: sent, timeout: this._timeoutMs, server: target }),
      { timeoutMs: this._timeoutMs, isStopped: () => this._session.isStopped(), timers: this._timers },
    );
  }

  /** Ask the user; returns the text to give the model when the action must not run, or null to proceed. */
  async _askUser(confirmation) {
    if (!this._confirm) return unavailableFeedback(confirmation.description);
    const approved = await this._confirm.ask({ description: confirmation.description, tool: confirmation.tool, risk: confirmation.risk });
    this._sink.diag("tool.confirm", { tool: confirmation.tool, approved });
    return approved ? null : declinedFeedback(confirmation.description);
  }

  /** Stop only abandons the wait: the command itself keeps running on the machine unless the server is told to end it. */
  _cancelJob(name, target, jobKey) {
    if (!jobKey || target !== "vscode") return;
    const cancel = { [JOB_ARGUMENT]: jobKey, [JOB_OP_ARGUMENT]: "cancel", [MODE_ARGUMENT]: this._approvalMode() };
    Promise.resolve(this._bridge.callTool({ name, arguments: cancel, timeout: 5000, server: target })).catch(() => {});
  }

  async _execute(name, args, target, jobKey) {
    let result = await this._callBridge(name, args, target, jobKey);
    if (result && result.kind === "stopped") { this._cancelJob(name, target, jobKey); return "(stopped by user)"; }
    if (needsApproval(result)) {
      const refusal = await this._askUser(result.confirmation);
      if (refusal) return refusal;
      // Repeat the very same call, now carrying the one-time token only the extension was given.
      result = await this._callBridge(name, { ...args, [RESERVED_ARGUMENT]: result.confirmation.token }, target, jobKey);
      if (result && result.kind === "stopped") { this._cancelJob(name, target, jobKey); return "(stopped by user)"; }
    }

    const feedback = toFeedback(result, {
      name,
      supportsVision: this._session.supportsVision(),
      timeoutSeconds: this._timeoutMs / 1000,
    });
    if (feedback.images) {
      this._sink.images(feedback.images, name);
      this._sink.diag("images.stashed", { count: feedback.images.length });
    }
    if (feedback.event === "stale-extension") {
      this._sink.staleExtension(result.error, name);
      this._sink.diag("bridge.staleExtension", { name, error: result.error });
    }
    return feedback.text;
  }
}
