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
      tools/                 category · catalogue · result-summary
      constants.js
    infrastructure/chat/     waitFor · StreamSampler · dom-helpers (shared by adapters)
    entry/                   background.js · popup.js · legacy-globals.js
  legacy/                    not yet migrated (see Status): main.js, providers/*
  manifests/base.json        shared manifest; per-browser deltas live in build/manifest.mjs
  build/                     manifest generation + esbuild bundling -> dist/{chrome,firefox}
  static/                    popup.html, overlay.css, icon
  test/                      node:test; domain tests need no browser
```

### Principles and where they are enforced

- **SRP** — one module, one reason to change. `test/architecture.test.js`
  caps domain modules at 250 lines.
- **Separation of concerns** — the same test fails if `domain/` touches
  `document`, `window`, `chrome`, `fetch`, etc., or imports outside `domain/`.
- **DRY** — site hosts were repeated in `manifest.json`, `background.js` and
  `popup.js`; they now come from `sites/registry.js`. The 14 content-script
  blocks are generated, not hand-written. Chat-site code that is identical
  across adapters moves into a shared base (see roadmap).
- **Testable** — pure functions take data and return data. Anything that needs
  the clock, the DOM or the network is behind a port.
- **Browser-neutral** — one source tree, two builds. Chrome gets
  `background.service_worker`; Firefox gets `background.scripts` plus
  `browser_specific_settings.gecko`.

### Build

```bash
cd extension && npm install
npm run build            # dist/chrome and dist/firefox
npm test
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
| `legacy/main.js` (~4.4k lines: loop + tool runner + session + chips + UI) | Next: split per the layer table |
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
2. **`application/`**: extract `ToolRunner` (isolation checks, `list_commands`,
   timeout/stop racing), `AgentLoop` (turn → parse → run → feed back) and
   `Session` (bootstrap, reminders, re-injection) from `main.js`, against the
   ports above, with fake-port tests.
3. **`ui/`**: split the ~1.5k-line `ui` IIFE into `bar`, `target-menu`,
   `mcp-settings`, `banners`; split `decorate` (chips) into `chips` + `camouflage`.
   Rendering takes a state object and returns DOM, so view state is testable.
4. **`infrastructure/bridge/`**: `BridgeClient` (socket, reconnect, heartbeat,
   request/response correlation) separate from the message router.
5. **Typing**: JSDoc `@typedef` for ports and messages + `tsc --checkJs` in CI.

## Bridge (`bridge.py`)

Responsibilities today: WebSocket server + auth, MCP subprocess client, tool
catalogue, config persistence. Roadmap: split into a `bridge/` package
(`server`, `mcp_client`, `catalog`, `config`, `protocol`) with the origin check
in `server`, so each is testable without sockets or subprocesses.

Security model: the socket only accepts connections whose `Origin` is a browser
extension (`chrome-extension://`, `moz-extension://`); web pages cannot forge
`Origin`, so they are rejected. Pin an exact extension with `ZS_ALLOWED_ORIGINS`.

## MCP server (`vscode_mcp.py`)

Roadmap: split into `tools/{fs,search,git,process}` behind a `policy` module
(path confinement, protected paths, command allow-list / confirmation for
destructive tools) and a `workspace` module (detecting the active folder), with
the JSON-RPC stdio loop as a thin shell.
