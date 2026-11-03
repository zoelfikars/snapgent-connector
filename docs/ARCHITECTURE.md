# Architecture

snapgent connects an AI chat in the browser to VS Code through MCP. Three deployable parts, one direction of dependency inside each.
How a chat site is read is taught by the user and stored as data: see [CALIBRATION.md](CALIBRATION.md).

```
 browser tab (AI chat site)              local machine
┌───────────────────────────┐   WS    ┌──────────────┐  stdio  ┌──────────────┐
│ extension (content script)│ ──────▶ │ bridge       │ ──────▶ │ MCP server   │
│  parse reply → run tool   │ ◀────── │ (WebSocket,  │ ◀────── │ (VS Code     │
│  → feed result back       │ via bg  │  MCP client) │         │  workspace)  │
└───────────────────────────┘         └──────────────┘         └──────────────┘
```

## Extension (`extension/`)

### Layers

Dependencies point **down** only. A layer never imports from a layer above it.

```
entry/           composition: one content script, the background worker, the popup
page/            this page: state, settings, the bar, the loop's wiring   (DOM and chrome.* allowed)
ui/              presentation: bar view, menus, notifications, dialogs    (DOM we own)
application/     use cases: agent loop, batch runner, tool runner, session (talks to ports)
infrastructure/  the chat site (calibrated engine), DOM helpers           (DOM we don't own)
domain/          pure rules: parser, prompt, results, budget              (no DOM, no I/O)
```

| Layer | Responsibility (one reason to change) | May use |
|---|---|---|
| `domain/` | What a command is, how it is parsed, what we tell the model, how results read, how big a message may be | nothing external |
| `application/` | The order of steps in a turn; one batch of commands; the session state machine | `domain`, ports |
| `infrastructure/` | Reading and writing one chat page from its stored profile | `domain` |
| `ui/` | Drawing state; emitting user intents | `domain` |
| `page/` | Wiring the above to this page: storage, the extension's worker, timers, the site's events | every layer below |
| `entry/` | Building the page objects in dependency order and starting them | everything |

**Ports** (interfaces the application layer depends on, implemented in `page/`) are typedefs in `application/ports.js`. Because the loop only
sees ports, it is tested with in-memory fakes and never needs a browser.

### Directory layout

```
extension/
  src/
    sites/registry.js        ONE list of supported sites -> manifest, background, popup, the switch-AI menu
    domain/
      parser/                markers · json-scan · tool-call (every command of a reply) · salvage · detect
      prompt/                system-prompt · feedback · reminder · resend · budget (size of one message)
      tools/                 catalogue · result-marker (the "» name" line) · result-summary · result-feedback · job-key
                             names · isolation · confirmation · virtual-commands
      agent/                 turn-policy · reply-classifier · session-start
      skills/                skill-text
    application/             AgentLoop · BatchRunner · ResponseWatcher · MessageSender · SessionStarter · ToolRunner
                             ToolCatalogue · SkillsService · PromptResender (+ SysTally) · SessionTracker · TurnMemory
                             BridgeMonitor · ServerDirectory · ProfileStore · StallWatchdog · ToolReminder · call-guard · ports
    infrastructure/
      calibration/           profile · selector-learning · engine (the provider built from a profile)
      chat/                  waitFor · StreamSampler · dom-helpers · dom-diagnostics
    ui/                      bar-view · bar-placer · bar-placement · menu-html · menu-position · pill · notifications
                             confirm-dialog · setup-card · mcp-settings · skills-settings · calibration wizard · input-cover · page-theme
    page/                    state · storage · settings · diagnostics · extension-bridge · provider (stored profile or "not calibrated")
                             visibility · chat (watcher + sender) · tools · loop · session · stop · user-input · auto-resume
                             prompt-resend · message-budget · batch-jobs · turns · page-watch · bridge-status
                             bar · bar-menus · pill-menu · site-menu · calibration-actions · files-menu · attachments
    entry/                   content.js (composition root) · background.js · popup.js
  manifests/base.json        shared manifest; per-browser deltas live in build/manifest.mjs
  build/                     manifest generation + esbuild bundling -> dist/{chrome,firefox}
  static/                    popup.html, overlay.css, icon
  test/                      node:test; domain and application tests need no browser
```

### How a turn runs

1. The page watches the site (`page-watch`, `user-input`, `auto-resume`). A reply that holds commands starts `AgentLoop`.
2. `ResponseWatcher` waits until the reply is complete and classifies it; `turn-policy` decides what to do with it.
3. `BatchRunner` runs the reply's commands in order. Each command carries a job key (batch id + place + content) and a share of the
   message-size budget; a failure, a stop or a full budget ends the batch and the rest is listed as not run.
4. `ToolRunner` calls the bridge under the user's approval mode. The VS Code server keeps each non-reading command as a job under its
   key, so a page reloaded mid-batch picks the batch up again instead of running it twice, and Stop can end the process.
5. The results go back as ONE message (`MessageSender`), each under its own `» name` line.

### Principles and where they are enforced

- **SRP** — one module, one reason to change. `test/architecture.test.js` caps every module of `domain`, `application`, `ui` and `page` at 250 lines.
- **Separation of concerns** — the same test fails if `domain/` or `application/` touch `document`, `window`, `chrome`, `fetch`, etc., if `ui/`
  touches `chrome.*` or the network, if a layer imports one above it, or if anything below `page/` imports it.
- **DRY** — site hosts, names and links come from `sites/registry.js`; the content-script blocks of the manifest are generated.
- **Testable** — the loop, the batch runner and the tool runner run against fake bridge/session/timer ports; the whole bundle is also booted
  against captured pages in jsdom (`test/content-script.test.js`). Pure functions take data and return data.
- **Browser-neutral** — one source tree, two builds. Chrome gets `background.service_worker`; Firefox gets `background.scripts` plus
  `browser_specific_settings.gecko`.

### Build

```bash
cd extension && npm install
npm run build            # dist/chrome and dist/firefox
npm test                 # unit + integration tests (no browser needed)
npm run lint             # no-undef catches dangling references
```

Load `extension/dist/chrome` as an unpacked extension in Chrome/Edge, or `extension/dist/firefox/manifest.json` via `about:debugging` →
*This Firefox* → *Load Temporary Add-on* (or `npm run run:firefox` with `web-ext`).

When a chat site changes its markup the answer is to re-calibrate that part (see CALIBRATION.md). Two diagnostics say what the page looks
like: `[zs-diag] layout.unreadable` (the site is generating but no reply turn is found) and `layout.sentMissing` (our own prompt is not
recognised as a user turn). Read them from the page console, or copy the whole log with `copy(document.getElementById("zs-diag-log").textContent)`.

## Bridge (`server/snapgent_bridge/`)

Everything the user runs lives in `server/`, laid out exactly like the release zip, so the
launchers work the same from a clone and from a download. Tests live in `tests/` and put
`server/` on `sys.path`.

`bridge.py` is a three-line entry point (every launcher still runs it); the
implementation is a package where each module has one reason to change.

```
bridge.py                  entry point -> snapgent_bridge.server.main()
snapgent_bridge/
  settings.py              paths, port, limits; the only module reading the environment
  logs.py                  logging (stdout always, file once configured)
  protocol.py              PURE: every message to/from the extension, tool-call parsing, result shaping
  security.py              PURE: who may connect (extension origins only, optional pinning)
  trust.py                 which extensions the user approved (asked once, remembered)
  config.py                PURE validation + ConfigStore (atomic config.json writes)
  mcp_client.py            one MCP server process over stdio JSON-RPC
  registry.py              running servers: catalogue, name collisions, tool resolution, isolation
  router.py                one handler per request type; talks through reply/broadcast, no sockets
  server.py                WebSocket accept + origin check + client set + monitor loop + run()
tests/                     unittest; pure modules need no processes or sockets
```

Dependencies point one way: `server -> router -> registry -> mcp_client`, with
`protocol`, `security` and `config` validation as leaves. The router and
registry are tested with fake servers; `test_server.py` uses real WebSockets and
a mock MCP process; `test_entrypoint.py` runs `python bridge.py` as the
launchers do and checks a clean SIGTERM shutdown.

Security model: the socket only accepts connections whose `Origin` is a browser
extension (`chrome-extension://`, `moz-extension://`); web pages cannot forge
`Origin`, so they are rejected with close code 1008. Pin an exact extension
with `ZS_ALLOWED_ORIGINS`. Tool calls carry the selected server and the
registry refuses any tool that belongs to another one (isolation).

Trust: passing the origin check only proves "some browser extension", and every installed extension
passes. So the first connection from an unknown extension origin is turned away and the person at the
bridge terminal is asked once (`trust.py`, like SSH `known_hosts`); a yes is stored in
`trusted_origins.json`, a no is remembered for the run, and a prompt that fails or has no terminal means
no. `ZS_ALLOWED_ORIGINS` pins the exact origin and skips the question. Without this, a hostile extension
could call tools, add servers (spawn commands) and approve its own confirmation tokens.

## VS Code MCP server (`server/snapgent_vscode/`)

`vscode_mcp.py` is a thin entry point (config files and launchers still point at it).

```
snapgent_vscode/
  limits.py  risk.py  context.py     constants, tool risk levels, Context(root, policy, session)
  workspace.py                       which folder VS Code has open (storage.json parsing is pure)
  paths.py                           every path must resolve inside the workspace root
  process.py                         child processes with bounded output (head + tail, the rest kept under a run_id) and time
  outputs.py                         the last 20 runs' full output, read back with get_command_output
  jobs.py                            commands as jobs under the extension's key: answered again without running twice, cancellable
  tools/                             each tool defined ONCE: schema + handler + risk (registry.py)
    project · reading · editing · git · commands
  security/                          the policy
    modes.py        readonly / standard / trusted, from the user's env (a typo never loosens it)
    files.py        secrets, .git, files that decide what scripts run
    commands.py     which run_command calls are harmless; cmd.exe metacharacter guard
    confirmation.py one-time, argument-bound approval tokens
    decision.py     decide(policy, tool, args, session) -> allow | confirm | deny   (pure)
  protocol.py  server.py             JSON-RPC and the stdio loop (a tool call per thread, so a running job can be asked about or cancelled)
```

Flow of a risky call: `McpServer` asks `decide`; on `confirm` it refuses with an MCP error result
whose structured data carries a token (text for the model never contains it). The bridge forwards it as
`kind: "confirmation_required"`; `ToolRunner` asks the user (`ConfirmPort`) and, if approved, repeats
the call with the token in a reserved argument it strips from anything the model sends.

Residual risk, stated plainly: code execution is inherent to a coding agent (write a file, run the
tests). The policy removes silent destructive/exfiltrating one-liners and secrets and makes the rest
visible; it is not a sandbox.

## CI and releases

- **`.github/workflows/ci.yml`** (every push/PR): extension lint + tests + both browser builds;
  Python tests on Ubuntu, Windows and macOS (3.9 and 3.14, plus 3.12 on Ubuntu); and a Windows job
  that builds `bridge.exe`/`vscode_mcp.exe` with PyInstaller and starts them.
- **`.github/workflows/release.yml`** (push a tag `vX.Y.Z`): refuses a tag that disagrees with
  `BRIDGE_VERSION`, builds the extension and the Windows executables, assembles the zip with
  `scripts/package_release.py` and publishes it. The executables are therefore never committed.
- **`scripts/package_release.py`** is the only place that knows what a release contains and where
  (launchers at the zip root so they can be double-clicked; execute bits set; no tests/docs/dev files).
  If the repository layout changes, change its tables, not the workflows.
- `tests/test_release.py` also pins the version: `extension/package.json`, `BRIDGE_VERSION`, the README
  badge and a CHANGELOG section must agree.
- The `.spec` files collect `websockets` and the package submodules; inside an `.exe`, `config.json`
  and `logs/` live next to the executable, not in PyInstaller's temp unpack folder (`settings.app_root`).

To cut a release: bump the version in `server/snapgent_bridge/__init__.py`, `extension/package.json` and the
README badge, add the CHANGELOG section, commit, then `git tag vX.Y.Z && git push --tags`.
