# Architecture

snapgent connects an AI chat in the browser to VS Code through MCP. Three
deployable parts, one direction of dependency inside each.

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
ui/              presentation: bar, menus, chips, banners          (DOM we own)
application/     use cases: agent loop, tool runner, session       (talks to ports)
infrastructure/  adapters: chat sites, bridge client, browser APIs (DOM we don't own, I/O)
domain/          pure rules: parser, prompt, tool formatting       (no DOM, no I/O)
```

| Layer | Responsibility (one reason to change) | May use |
|---|---|---|
| `domain/` | What a command is, how it is parsed, what we tell the model, how results read | nothing external |
| `application/` | The order of steps in a turn; session state machine | `domain`, ports |
| `infrastructure/` | Reading/writing one specific chat site; the WebSocket; `chrome.*`/`browser.*` | `domain` |
| `ui/` | Drawing state; emitting user intents | `domain` |
| `entry/` | Wiring only: construct adapters, inject them, start | everything |

**Ports** (interfaces the application layer depends on, implemented in
infrastructure): `ChatPort` (read replies, send text, stop, lock input),
`BridgePort` (list tools, call tool, status), `StoragePort`, `ClockPort`.
Because the loop only sees ports, it is tested with in-memory fakes and never
needs a browser.

### Directory layout

```
extension/
  src/
    sites/registry.js        ONE list of supported sites -> manifest, background, popup
    domain/
      parser/                markers · json-scan · tool-call · salvage · detect
      prompt/                system-prompt · feedback · reminder
      tools/                 category · catalogue · result-summary · names · isolation
                             virtual-commands · result-feedback
      agent/                 turn-policy · reply-classifier · session-start (preconditions, handshake)
      skills/                skill-text (frontmatter parsing + validation)
      constants.js
    application/             AgentLoop · ResponseWatcher (+ WatchState) · MessageSender · SessionStarter
                             ToolRunner · ToolCatalogue · SkillsService · PromptResender (+ SysTally)
                             StallWatchdog · ToolReminder · call-guard · ports (typedefs)
    ui/                      confirm-dialog · notifications · mcp-settings · skills-settings · setup-card · popup
                             bar-view · bar-placement · menu-position · cover-geometry · cover-color · page-theme
                             chip-view · chip-icons · turn-chips · html (escaping) · index
    infrastructure/chat/     chatgpt-layouts (page layouts as data) · dom-diagnostics · waitFor · StreamSampler · dom-helpers (shared by adapters)
    entry/                   background.js · popup.js · legacy-globals.js
  legacy/                    not yet migrated (see Status): main.js, providers/*
  manifests/base.json        shared manifest; per-browser deltas live in build/manifest.mjs
  build/                     manifest generation + esbuild bundling -> dist/{chrome,firefox}
  static/                    popup.html, overlay.css, icon
  test/                      node:test; domain tests need no browser
```

### Principles and where they are enforced

- **SRP** — one module, one reason to change. `test/architecture.test.js`
  caps domain and application modules at 250 lines.
- **Separation of concerns** — the same test fails if `domain/` or
  `application/` touch `document`, `window`, `chrome`, `fetch`, etc., or import
  from a layer above them (`domain` imports only `domain`; `application` only
  `application` + `domain`).
- **DRY** — site hosts were repeated in `manifest.json`, `background.js` and
  `popup.js`; they now come from `sites/registry.js`. The 14 content-script
  blocks are generated, not hand-written. Chat-site code that is identical
  across adapters moves into a shared base (see roadmap).
- **Testable** — `ToolRunner` runs against fake bridge/session/timer ports with
  no browser; smoke tests also boot the real `globals.js → adapter → main.js`
  sequence in a sandbox. Pure functions take data and return data. Anything that needs
  the clock, the DOM or the network is behind a port.
- **Browser-neutral** — one source tree, two builds. Chrome gets
  `background.service_worker`; Firefox gets `background.scripts` plus
  `browser_specific_settings.gecko`.

### Build

```bash
cd extension && npm install
npm run build            # dist/chrome and dist/firefox
npm test                 # unit + smoke tests (no browser needed)
npm run lint             # no-undef across legacy code catches dangling references
```

Load `extension/dist/chrome` as an unpacked extension in Chrome/Edge, or
`extension/dist/firefox/manifest.json` via `about:debugging` → *This Firefox* →
*Load Temporary Add-on* (or `npm run run:firefox` with `web-ext`).

### Status — strangler migration

The old code keeps working while it is replaced piece by piece; every step is
shippable.

| Piece | State |
|---|---|
| Parser, prompt, feedback, tool formatting, result summaries | **Migrated** to `domain/`, unit-tested |
| Manifest, host lists, per-browser build | **Migrated** (`sites/`, `build/`) |
| Bridge origin check | **Done** (`server/snapgent_bridge`) |
| Tool execution (`runTool`, catalogue, isolation, `list_commands`, result shaping) | **Migrated** to `application/` + `domain/tools/`, tested with fake ports |
| Agent loop (`agentLoop`: turn policy, lifecycle, stall watchdog, reminder cadence) | **Migrated** to `domain/agent` + `application/`, scripted-scenario tests |
| Response watcher (`waitForResponse`: timing gates + reply classification) | **Migrated** to `application/response-watcher` + `domain/agent/reply-classifier`, fake-clock tests |
| Send path (`submitAndGetBase`), session bootstrap (`startSession`), system-prompt re-injection, skills | **Migrated** (`MessageSender`, `SessionStarter`, `PromptResender`/`SysTally`, `SkillsService`), tested with scripted ports |
| UI: dialog, bar decision/placement, menus, cover, theme, chips for our own turns, notifications, setup card, popups | **Migrated** to `ui/`, jsdom/unit tested |
| `BridgeMonitor` (is the server usable, workspace probe), `SessionTracker` (is this chat a session, moved-away detection), `ServerDirectory` (server names, toggles, custom prompt), `TurnMemory` (halted/executed turns outside the DOM) | **Migrated** to `application/`, tested with fake ports |
| `legacy/main.js` (~2.4k lines: `decorate.classify` for model turns, bar `build()`, menus, stop button, wiring) | Next; the per-site DOM fixtures it needs now exist (below) |
| `legacy/providers/*` (12 adapters, ~8.1k lines) | Shared primitives extracted; adapter family factory next |
| `entry/background.js` | Bridge client + message router still in one file |

### Roadmap (each item is its own PR)

1. **Shared chat-adapter primitives.** *(first part done)* Measuring the 12
   adapters showed that most same-named functions (`typeAndSend`, `snapshot`,
   `readAssistant`, `installSendHooks`, ...) are genuinely site-specific, so a
   big base class would have hidden real differences. Only the code that was
   truly identical moved to `infrastructure/chat/`: `waitFor`, `StreamSampler`
   (reply-growth detection), `clickIfPresent`, `setNativeValue`, `fileFromImage`,
   plus `COMMAND_SHAPE_RE` in the domain. ~250 duplicated lines are gone.
   Still to do: the near-identical Claude/Grok/Mistral/Ptero family
   (`getEditor`, `writeText`, `snapshot`, `readAssistant`) becomes a
   `createGenericAdapter(selectors)` factory; the other eight keep their quirks
   behind a documented adapter contract (`ChatPort`).
2. **`application/`** *(done)*: `ToolRunner`, `AgentLoop`, `ResponseWatcher`,
   `MessageSender`, `SessionStarter`, `PromptResender`, `SkillsService`. What is
   left in `main.js` is presentation and wiring, which is what `ui/` is for.
3. **`ui/`** *(mostly done)*. Extracted and tested: the approval dialog, status-bar decision, bar
   placement (mode choice + geometry), menu placement, input-cover geometry and colour, page theme,
   chip drawing and chips for system/result turns, notifications, setup card and both settings
   popups. What is left in `legacy/main.js` is the part that cannot be judged without each site's DOM:
   `decorate.classify` for turns the MODEL wrote (command turns depend on streaming state and
   per-site markup flags), the `build()` of the bar, the "more"/target menus, and the stop button
   state. They are best moved only together with DOM fixtures for the other sites (now in place, see below).
4. **`infrastructure/bridge/`**: `BridgeClient` (socket, reconnect, heartbeat,
   request/response correlation) separate from the message router.
5. **Typing**: JSDoc `@typedef` for ports and messages + `tsc --checkJs` in CI.

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
  process.py                         child processes with bounded output/time
  tools/                             each tool defined ONCE: schema + handler + risk (registry.py)
    project · reading · editing · git · commands
  security/                          the policy
    modes.py        readonly / standard / trusted, from the user's env (a typo never loosens it)
    files.py        secrets, .git, files that decide what scripts run
    commands.py     which run_command calls are harmless; cmd.exe metacharacter guard
    confirmation.py one-time, argument-bound approval tokens
    decision.py     decide(policy, tool, args, session) -> allow | confirm | deny   (pure)
  protocol.py  server.py             JSON-RPC and the stdio loop
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

## When a chat site changes its markup

Sites change their DOM without notice; this is the expected failure mode, so it is built to be
visible and cheap to fix.

1. **It fails loudly.** If the site is generating but the adapter sees no reply turn for 15 s,
   the wait ends as `unreadable` with a banner, and `layout.unreadable` is logged with the element
   chains around text we know is on the page (our `⟦ZS-SYS⟧` marker and the model's `"command"`).
   If our own prompt is not recognised as a user turn, `layout.sentMissing` is logged and a warning
   is shown. Read them from the page console: `[zs-diag] layout.unreadable`.
2. **Layouts are data.** ChatGPT's turn selectors, role, reply container and id live in
   `src/infrastructure/chat/chatgpt-layouts.js`, one entry per layout; the adapter uses the first
   one that matches the page.
3. **Fixtures pin it.** Every adapter has one in `test/fixtures/sites/` and runs the same contract in
   `test/sites-contract.test.js` (counts, reading the tool call, ignoring reasoning and page chrome, finding the
   composer, hiding the block, Stop control). Those fixtures are written from each adapter's selectors, because
   logged-in captures are not available, so they guard the adapter logic, not drift in the live site: when a site
   changes, replace its file with a real capture and the same contract applies. ChatGPT's captured layouts
   live in `test/fixtures/` with their own tests in `test/chatgpt-layouts.test.js`; `test/content-script.test.js` runs the whole extension on it.

Automatic discovery of turns by anchoring on known text was considered and deliberately not built:
a wrong guess hides or targets the wrong element silently, which is worse than failing loudly.
