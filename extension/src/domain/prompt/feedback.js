// SPDX-License-Identifier: GPL-3.0-or-later
// Messages sent back to the model so it can self-correct. Pure data.

// Feedback strings sent back to the model so it can self-correct.
export const FEEDBACK = {
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
