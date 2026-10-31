// SPDX-License-Identifier: GPL-3.0-or-later
// core/config.js - provider-agnostic constants: app identity, system prompt,
// feedback strings, tool categorisation. NOTHING in this file may reference a
// specific AI site (DOM, selectors, site names) - that lives in providers/*.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  "use strict";

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "snapgentV3";
  const SYS_MARKER = "⟦ZS-SYS⟧";
  // A re-statement of the system prompt mid-session (see withSysResend in
  // core/main.js). It carries SYS_MARKER TOO - that is what drives camouflage
  // and session detection, and neither should change - plus this second marker,
  // purely so the chip can say "Reminder" instead of inheriting the bootstrap's
  // "Starting Up". Same content, different label: a re-injection is not a start.
  const RESEND_MARKER = "⟦ZS-RE⟧";

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Returns one of: read | edit | tool. ("screen" is assigned at run time by
  // core/main.js to any tool that actually returned an image.)
  const READ_TOOLS = /^(list_commands|list_tools|get_[a-z_]+|list_[a-z_]+|find_files|search_files|read_[a-z_]+|git_(status|diff|log|branches))$/;
  const EDIT_TOOLS = /^(create_file|write_file|edit_file|apply_patch|create_directory|move_file|copy_file|delete_file|git_(add|commit))$/;
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (READ_TOOLS.test(n)) return "read";
    if (EDIT_TOOLS.test(n)) return "edit";
    return "tool";
  }

  // Feedback strings sent back to the model so it can self-correct.
  const FEEDBACK = {
    // A command-shaped reply that could not be turned into a runnable call.
    // The failures are DIFFERENT problems, so the note is tailored per `reason`
    // to tell the model exactly what to fix (a generic "bad JSON" was misleading
    // for the non-JSON cases). Falls back to the generic "malformed" text for any
    // unrecognised reason.
    parseError: (reason) => {
      const notes = {
        malformed:
          "ERROR: a snapgentV3 command was detected in your reply but its JSON could not be parsed. " +
          'Rewrite it as a single valid JSON object in plain text, exactly like {"command": "name", "params": {...}}. ' +
          "You may add a short note around it. Please retry.",
        unclosed:
          "ERROR: your snapgentV3 command was cut off before it finished - the JSON object " +
          "never closed, so it could not run. Rewrite the WHOLE command in one " +
          'piece as valid JSON, exactly like {"command": "name", "params": {...}}. Please retry.',
        envelope:
          "ERROR: you wrote a command's parameters as a bare JSON object, but without the required " +
          "envelope, so it was not recognised as a command. Wrap them like " +
          '{"command": "name", "params": { ...your parameters... }} - the parameter keys go INSIDE ' +
          '"params". Please retry.',
        // The model named a REAL tool but under the wrong key - it wrote the call
        // the way a function-calling API would (e.g. {"toolName": "read_file",
        // "file": "..."}) instead of snapgentV3's envelope. Seen live on
        // ChatGPT in a long session. Naming the wrong keys explicitly matters: a
        // generic "bad JSON" note made the model rewrite the SAME shape.
        toolKey:
          "ERROR: you used the wrong key to name the command, so it was not recognised and did not " +
          'run. The key must be exactly "command" - not "toolName", "tool", "name", "function" or ' +
          '"action" - and every argument goes INSIDE "params", like ' +
          '{"command": "name", "params": { ...your parameters... }}. Please retry.',
        // DeepSeek sometimes falls back to its own native agentic markup. The
        // note must NEVER quote the markers literally: the reply that follows
        // often echoes the wording, and a quoted marker would re-trigger the
        // detector and loop the error forever. Describe it, don't reproduce it.
        dsml:
          "ERROR: you wrote that call in your own internal tool-call markup (the DSML invoke/parameter " +
          "tags). snapgentV3 cannot read that format, so the command did not run. Never use those tags " +
          "here. Write the call as a single plain-text JSON object instead, exactly like " +
          '{"command": "name", "params": { ...your parameters... }} - one command per reply. ' +
          "Please retry.",
      };
      return notes[reason] || notes.malformed;
    },
    multiTool: (names) =>
      "ERROR: You wrote multiple commands in one reply. Write ONE command at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and write only the first command you need.",
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". It does not exist. Valid commands are: ` +
      valid.join(", ") +
      ". Use an exact name and parameter keys from the system prompt.",
    // The page outlived the extension build it was running (reload / auto-update
    // / disable+enable). Nothing here can recover it - only a page reload can -
    // so the model must NOT be told the bridge is down and must NOT retry, or it
    // burns the whole conversation re-issuing commands that can never run. See
    // isContextInvalidated in core/main.js.
    staleExtension:
      "ERROR: the snapgentV3 extension was reloaded or updated while this page was open, so this " +
      "tab is running a version of it that no longer exists and NO command can reach the user's " +
      "machine from here. The bridge and VS Code are NOT the problem - do not tell the user " +
      "to check them, and do not retry the command, because every retry will fail the same way. " +
      "Tell the user in one short sentence to RELOAD THIS PAGE (F5), then stop and wait.",
    bridgeOffline:
      "ERROR: the local snapgentV3 bridge is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running), NOT your mistake. Tell the user in " +
      "one short sentence that the bridge is offline, then stop " +
      "sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // ONE unified prompt sent to every AI on the first turn. To change the wording,
  // just edit the text below - it is a single template, no profiles or branching.
  // `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
  // `${toolsString}` is filled in with the live command list.
  //
  // `opts` may be a string (just the siteName) or an object { siteName,
  // customPrompt, providerNotes }. `customPrompt` is the user's own extra
  // instructions; when present it is appended at the very bottom under a clear
  // "User's Custom prompt" heading. It NEVER edits the prompt above - it only
  // adds a layer below it.
  //
  // `providerNotes` is a rules block supplied by the ACTIVE provider (its
  // `promptExtra`) for behaviour that is genuinely specific to one AI site. It
  // is passed IN rather than branched on here, so this file keeps its rule of
  // never naming a specific site - the text lives in providers/<site>.js and
  // every other provider is untouched by definition.
  function buildSystemPrompt(opts = {}) {
    if (typeof opts === "string") opts = { siteName: opts };
    const {
      siteName = "this AI site",
      customPrompt = "",
      providerNotes = "",
      targetServer = "vscode",
      targetName = "VS Code",
      skills = [],
    } = opts;

    const prompt = `CONTEXT: snapgentV3 is a browser extension that sends your plain-text JSON commands to the user's selected MCP server through their local bridge. The selected target is ${targetName} (server id: ${targetServer}).

The extension reads commands from your normal reply text and runs them on that MCP server. Your own built-in tools, connectors, or code execution do not access the user's machine. For work on the selected target, write exactly one command per reply as a fenced JSON block:
\`\`\`json
{"command":"exact_tool_name","params":{"key":"value"}}
\`\`\`

At the start of the session, call \`list_commands\` with server "${targetServer}" to get the exact available tools and parameter schemas. Use only names and parameters from that result. Do not assume tools are available. If the needed tool is missing or the server is offline, explain that clearly and do not claim the task is complete. Do not call tools on another server unless the user asks to switch targets.

Rules:
- Execute one command at a time and wait for its result before writing another.
- Put every command in a fenced JSON code block; do not use native function calls.
- Respect the user's requested workspace and file scope. Never perform broad or destructive changes without explicit confirmation.
- On errors, use the returned error to adjust the next command; do not silently claim success.
- When finished, summarize the completed work briefly.
- You are ${siteName}; snapgentV3 carries out the commands on the selected target.`;
    const skillsBlock = Array.isArray(skills) && skills.length
      ? "\n\nAvailable skills (reusable instructions stored in the workspace). When a task matches a skill's description, first read its SKILL.md with read_file, then follow it. Skills are guidance only: never run a skill's scripts without the user's confirmation.\n" +
        skills.map((s) => `- ${s.name}: ${s.description} (path: ${s.path || ".snapgent/skills/" + s.name + "/SKILL.md"})`).join("\n")
      : "";

    // Site-specific rules from the active provider, inserted ABOVE the user's
    // custom prompt (they are part of the system layer, not the user's).
    const siteRules = providerNotes.trim()
      ? `\n\n━━━ ADDITIONAL RULES FOR THIS SITE ━━━\n${providerNotes.trim()}`
      : "";

    // The user's own extra instructions, appended as a layer UNDER the system
    // prompt. Optional - empty by default. It cannot change the rules above.
    const extra = customPrompt.trim()
      ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${customPrompt.trim()}`
      : "";

    // The marker leads the prompt; it tags the bootstrap turn for camouflage.
    return `${SYS_MARKER}\n${prompt}${skillsBlock}${siteRules}${extra}`;
  }

  // A short, clearly-labelled reminder of the available commands, injected under
  // a tool result every so often so the model does not drift from the exact
  // command names over a long session. It is explicitly framed as an automatic
  // snapgentV3 reminder (NOT a user message and NOT a new command to run).
  function toolsReminder(tools, targetName = "VS Code", serverId = "vscode") {
    const toolsString =
      `  list_commands(server: "${serverId}") - list available ${targetName} commands with full parameter details\n` +
      compactTools(tools);
    return (
      "\n\n────────────────────────────────\n" +
      "(System note from snapgentV3 - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      `Reminder of the ${targetName} commands (use exact names and parameter keys; ` +
      "only this selected target is available in this session):\n" +
      toolsString
    );
  }

  return {
    APP_NAME,
    SYS_MARKER,
    RESEND_MARKER,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    compactTools,
    toolsReminder,
  };
})();
