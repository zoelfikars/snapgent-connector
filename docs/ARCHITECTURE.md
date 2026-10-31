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
| Bridge origin check | **Done** (`bridge.py`) |
| Tool execution (`runTool`, catalogue, isolation, `list_commands`, result shaping) | **Migrated** to `application/` + `domain/tools/`, tested with fake ports |
| Agent loop (`agentLoop`: turn policy, lifecycle, stall watchdog, reminder cadence) | **Migrated** to `domain/agent` + `application/`, scripted-scenario tests |
| Response watcher (`waitForResponse`: timing gates + reply classification) | **Migrated** to `application/response-watcher` + `domain/agent/reply-classifier`, fake-clock tests |
| Send path (`submitAndGetBase`), session bootstrap (`startSession`), system-prompt re-injection, skills | **Migrated** (`MessageSender`, `SessionStarter`, `PromptResender`/`SysTally`, `SkillsService`), tested with scripted ports |
| `legacy/main.js` (~3.4k lines: chips/camouflage + UI + wiring) | Next: `ui/` (bar, menus, settings popups) and chip/camouflage rendering |
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
3. **`ui/`**: split the ~1.5k-line `ui` IIFE into `bar`, `target-menu`,
   `mcp-settings`, `banners`; split `decorate` (chips) into `chips` + `camouflage`.
   Rendering takes a state object and returns DOM, so view state is testable.
4. **`infrastructure/bridge/`**: `BridgeClient` (socket, reconnect, heartbeat,
   request/response correlation) separate from the message router.
5. **Typing**: JSDoc `@typedef` for ports and messages + `tsc --checkJs` in CI.

## Bridge (`snapgent_bridge/`)

`bridge.py` is a three-line entry point (every launcher still runs it); the
implementation is a package where each module has one reason to change.

```
bridge.py                  entry point -> snapgent_bridge.server.main()
snapgent_bridge/
  settings.py              paths, port, limits; the only module reading the environment
  logs.py                  logging (stdout always, file once configured)
  protocol.py              PURE: every message to/from the extension, tool-call parsing, result shaping
  security.py              PURE: who may connect (extension origins only, optional pinning)
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

Not covered yet: `add_server` lets a connected extension register an arbitrary
command to spawn. Behind the origin check that is acceptable, but a pairing
token or a confirmation step would remove the remaining trust in "any installed
extension".

## MCP server (`vscode_mcp.py`)

Roadmap: split into `tools/{fs,search,git,process}` behind a `policy` module
(path confinement, protected paths, command allow-list / confirmation for
destructive tools) and a `workspace` module (detecting the active folder), with
the JSON-RPC stdio loop as a thin shell.

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
3. **Fixtures pin it.** Save the captured markup in `test/fixtures/`, add a test in
   `test/chatgpt-layouts.test.js`; `test/content-script.test.js` runs the whole extension on it.

Automatic discovery of turns by anchoring on known text was considered and deliberately not built:
a wrong guess hides or targets the wrong element silently, which is worse than failing loudly.
