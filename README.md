<div align="center">

<a href="https://github.com/zoelfikarshomelab/snapgent-connector">
<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=800&size=52&duration=3000&pause=1000&color=FACC15&center=true&vCenter=true&width=700&height=90&lines=snapgentV3;+Connector+agent+MCP" alt="snapgentV3: Connector agent for VS Code" />
</a>

<p><b>Turn any AI chatbot browser to many app via MCP</b></p>

<p><a href="https://discord.gg/rvaZ8KkvAX"><b>💬 Join Discord</b></a> to report problem</p>

[![License](https://img.shields.io/badge/LICENSE-GPL--3.0-FACC15?style=flat-square&labelColor=111111&logo=opensourceinitiative&logoColor=FACC15)](LICENSE)
[![Manifest](https://img.shields.io/badge/MANIFEST-V3-FACC15?style=flat-square&labelColor=111111&logo=googlechrome&logoColor=FACC15)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3/)
[![Release](https://img.shields.io/badge/RELEASE-V3.9.4-FACC15?style=flat-square&labelColor=111111&logo=semanticrelease&logoColor=FACC15)](https://github.com/zoelfikarshomelab/snapgent-connector/releases/tag/V3.9.4)
[![MCP](https://img.shields.io/badge/PROTOCOL-MCP-FACC15?style=flat-square&labelColor=111111&logo=modelcontextprotocol&logoColor=FACC15)](https://modelcontextprotocol.io/)

</div>

> **Status: chat-site support is being rebuilt.** The built-in per-site adapters were removed in favour of a short
> one-time *calibration* where you point the extension at your chat's text box, send button and a reply
> ([design](docs/CALIBRATION.md)). Until that lands the extension loads, connects to the bridge and lets you switch
> between AI sites, and **Calibrate** (bar, or the switch-AI menu) teaches it a site in about a minute; export and import share
> the result. Until a site is calibrated it cannot run the agent there. The last version with the old adapters is the git tag `pre-calibration`.

```console

  ███████╗███╗   ██╗ █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗
  ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
  ███████╗██╔██╗ ██║███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║
  ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ██║   ██║██╔══╝  ██║╚██╗██║   ██║
  ███████║██║ ╚████║██║  ██║██║     ╚██████╔╝███████╗██║ ╚████║   ██║
  ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝

  > browser extension + local bridge for VS Code and MCP
  > no API key · no terminal · no copy-paste
```

snapgentV3 is a browser extension plus a local bridge that connects a normal AI chat to **VS Code**. It automatically uses the currently open workspace. Describe what you want in plain language — the extension forwards commands to the selected server through the local bridge, and returns the results to chat.

**Free and open source — no API key, subscription, or sign-in required.** snapgentV3 automatically uses the currently open VS Code workspace.

---

- **Installation:** [Watch Installation Video](https://youtu.be/eo3sdtPSBso)
- **Demo:** [Watch Demo Video](https://youtu.be/HY0YWsHLp34)

- **MCP support**
<img src="assets/mcpsupport.jpeg" width="300" alt="Logo Project">

- **Test snapgent connector + effect craft motion from artcraft** [Watch Video](https://youtu.be/wH_gpAWpA8E)
<table>
<tr>
<td width="100%" valign="top">

### 💻 VS Code
The default target. Automatically connects to the workspace currently open in VS Code.

</td>
</tr>
</table>

---

## `01` &nbsp; How it works

```
┌─────────────┐     plain-text      ┌──────────────────┐    WebSocket    ┌────────────┐    MCP    ┌────────────────┐
│  AI chat    │ ───  commands  ───▶ │ snapgentV3       │ ──────────────▶ │  Bridge    │ ────────▶ │ Selected MCP   │
│  (browser)  │ ◀──  results   ───  │ browser extension│ ◀────────────── │ (local)    │ ◀──────── │ target         │
└─────────────┘                     └──────────────────┘                 └────────────┘           └────────────────┘
```

1. **You** describe a task in a supported AI chat.
2. The **AI** replies with a snapgentV3 command.
3. The **extension** detects the command and forwards it to the local bridge.
4. The **bridge** routes it to the Snapgent MCP server.
5. The **result** is sent back into chat, and the AI continues working.

VS Code's MCP server is configured by `snapgent` itself; it detects the open VS Code workspace automatically.

---

## `02` &nbsp; Supported AI providers

| Provider | URL | Status | Notes |
|---|---|---|---|
| **ChatGPT** | `chatgpt.com` | ✅ Supported | Image input and screenshots are disabled |
| **Claude** | `claude.ai` | ✅ Supported | Image input and screenshots are disabled |
| **Google Gemini** | `gemini.google.com` | ✅ Supported | May stop using tools in long sessions |
| **Kimi** | `kimi.ai` | ✅ Supported | May use its native tools in some sessions |
| **Grok** | `grok.com` | ✅ Supported | Requires signing in to xAI |
| **Mistral (Vibe Code)** | `chat.mistral.ai` | 🧪 Experimental | Requires signing in to Mistral; selectors need testing on the live site |
| **GLM (Z.ai)** | `chat.z.ai` | ✅ Supported | |
| **Qwen** | `chat.qwen.ai` | ✅ Supported | |
| **Arena** | `arena.ai` | ✅ Supported | Use **Direct** mode |
| **Meta AI** | `meta.ai` | ✅ Supported | |
| **Ptero** | `ptero.pro` | ✅ Supported | |

> Add a site in `extension/src/sites/registry.js`; the manifest, background worker and popup are generated from it.

---

## `03` &nbsp; Requirements

- **Microsoft Edge** or **Google Chrome** (Manifest V3).
- **VS Code** for the default target. Keep the workspace you want to use open in VS Code.
- **Windows**, **macOS**, or **Linux** for the bridge.
- **Python 3.9+** on macOS (run from a clone). Windows (`snapgent.exe`) and Linux (`snapgent`) need no Python.
- The bridge running while you use the agent.

---

## `04` &nbsp; Installation

**① Load the extension**

1. Download and extract the [latest SnapgentV3 release](https://github.com/zoelfikarshomelab/snapgent-connector/releases/tag/V3.9.4).
2. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `chrome` folder of the release (or `extension/dist/chrome` if you built from source).
5. The snapgentV3 icon appears in your browser toolbar.

**Firefox (128+):** open `about:debugging` → *This Firefox* → *Load Temporary Add-on* and pick `manifest.json` from the `firefox` folder
(or `extension/dist/firefox`). Firefox may ask you to grant the site permissions from the extension's *Permissions* tab.

**Building from source:** `cd extension && npm install && npm run build` produces `dist/chrome` and `dist/firefox`.

**② Set up the MCP target**

For VS Code, open the project folder you want to work on before clicking **Start** in the chat bar. The bridge can be started before VS Code; the agent waits until a workspace is available and does not fall back to the Snapgent release folder.

**③ Start the bridge**

- **Windows** — download `snapgent.exe` from the release and double-click it. One program: it configures VS Code MCP, replaces an older
  bridge that is still running and serves; keep its window open. You can start the bridge before VS Code. Machine-specific settings are
  written to a local `config.json` next to the program. Windows SmartScreen may ask once because the program is not signed: choose
  **More info → Run anyway**.
- **Linux** — download `snapgent-linux-x64-v<version>.tar.gz`, then in a terminal:
  `tar xzf snapgent-linux-x64-*.tar.gz && ./snapgent`. One program, no Python needed: it writes its own VS Code
  MCP configuration next to itself, replaces an older Snapgent bridge that still holds the port, and runs the bridge.
  Keep the terminal open while you use Snapgent.
- **macOS** — from a clone, with Python 3.9+: `pip3 install websockets`, then `python3 server/snapgent.py`. It is the same program as the
  Windows and Linux ones, run by Python. (A ready-made macOS program is not published yet.)

The extension comes as `snapgent-extension-v<version>.zip` (`chrome/` and `firefox/`).

**First connection: approve your extension.** The first time an extension connects, the terminal running the bridge asks:

```
  ----------------------------------------------------------------
  A browser extension wants to control this bridge:

      moz-extension://1f2e3d4c-...

  Approve it ONLY if it is your own snapgentV3 extension (it will stay approved).
  Type y and press Enter to allow it, or anything else to refuse.

  Allow? [y/N]
```

Type `y` only for your own snapgentV3 extension. The question is answered in **the same terminal** where
you started the bridge, not in the browser; until you press Enter the extension keeps retrying and the popup
says *Approve in the bridge terminal*. The answer is remembered in `trusted_origins.json` (so a
different extension installed in your browser cannot drive your project). Without a terminal to ask in, pin
the exact origin with the `ZS_ALLOWED_ORIGINS` environment variable instead. Reloading a temporary Firefox
add-on gives it a new origin, so you will be asked once more.

Keep the terminal window open while the bridge runs.

**Optional: other MCP servers (EffectCraft, Roblox Studio, ...)**

`snapgent` configures only the VS Code server by itself. It no longer detects EffectCraft or Roblox Studio: add any other MCP server
to the `mcpServers` section of the local `config.json` (next to the program, or in `server/` from a clone) and restart the bridge.
It then appears in the MCP target selector on the chat bar.

**④ Start a session**

1. Open a supported AI chat site and start a new chat.
2. Open a project folder in VS Code before clicking **Start**.
3. Click **Start** and describe what you want to make.

**⑤ Updating to a new release**

The extension and the bridge are two separate parts, and each one has to be updated. Reloading only the extension does not update the bridge, and the **Restart** button in the extension popup only restarts the MCP servers, it does not load new bridge code.

1. Get the new version: run `git pull` in the project folder (the program is `server/snapgent.py`), or download and extract the [latest release](https://github.com/zoelfikarshomelab/snapgent-connector/releases/latest).
2. Stop the old bridge: close the window or terminal that is running `snapgent`.
3. Start `snapgent` again. It replaces an old bridge still holding port 17613. On Linux it first checks that the process on the port is a Snapgent bridge, and stops with an error if it belongs to another program.
4. Reload the extension at `chrome://extensions` (or `edge://extensions`), then refresh open chat tabs (F5).
5. Check the versions: click the snapgentV3 icon. The popup header shows `ext vX · bridge vY`, and both numbers should match the release you installed. The bridge also writes `snapgent bridge vY` to its startup log.

If the popup shows `bridge old`, the bridge is still running old code: repeat steps 2 and 3.

---

## `05` &nbsp; Usage

Once a session is running, just talk to the AI normally:

> "Inspect the files in my project and explain how the login flow works."

> "Add a search bar to the books page and wire it to the existing API."

The AI sends commands, snapgentV3 runs them in the selected target (VS Code by default), and the results appear in chat. You can give the AI another instruction at any time.

**Tips**

- Keep the bridge window open — closing it disconnects the agent.
- Keep your intended project open in VS Code; it is the default MCP target.
- On **Arena**, use **Direct** mode.
- If **Gemini** or **Kimi** stops using tools in a long session, remind it to use the snapgentV3 commands or start a new chat.

---

## `06` &nbsp; Architecture

The extension is split into layers that only depend downwards: a **pure domain**, the **application** use cases, the **page** wiring and one **content script** that composes them. A chat site is read from a profile the user teaches ([docs/CALIBRATION.md](docs/CALIBRATION.md)). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for layers and rules.

```
src/domain/                 pure logic: command parsing, system prompt, results, message budget
src/application/            the agent loop, batches of commands, sessions (against ports)
src/infrastructure/         the calibrated engine that reads a chat page from its profile
src/ui/                     bar, menus, notices, dialogs
src/page/                   wiring to this page: settings, storage, the bar, the loop, the stop button
src/sites/registry.js       the one list of supported AI sites
src/entry/                  content script (composition), background worker, popup
build/                      per-browser manifest generation and bundling
```

The bridge routes commands to the configured MCP servers. It is one program, `snapgent`: `snapgent.exe` on Windows, `snapgent` on Linux,
`python3 server/snapgent.py` on macOS (and from any clone).

---

## `07` &nbsp; Project structure

```
snapgent-full/
├── extension/                 # Browser extension source (Chrome/Edge and Firefox)
│   ├── src/                   # domain, application, infrastructure, ui, page, entry
│   ├── build/                 # Manifest generation + bundling -> dist/{chrome,firefox}
│   └── test/                  # node:test suites (npm test)
├── server/                    # Everything you run: same layout as the release zip
│   ├── snapgent.py            # The one program: the bridge, or the Snapgent MCP server with --mcp
│   ├── snapgent_bridge/       # Bridge implementation (protocol, registry, router, trust, server, launcher)
│   ├── snapgent_mcp/       # Snapgent MCP server implementation (tools, security policy)
│   └── snapgent.spec          # PyInstaller recipe (snapgent.exe and snapgent are built by CI)
├── tests/                     # Python tests (python -m unittest discover -s tests -t .)
├── scripts/                   # package_release.py assembles the release files
├── docs/                      # Architecture notes and the project page
├── assets/                    # Project images
└── .github/workflows/         # CI and release automation
```

---

## `07b` &nbsp; Safety: what the AI may do

The AI chat is a website you do not control, and what it reads (web pages, documents) can contain
instructions aimed at it. So the VS Code server does not simply do whatever it is asked:

| Action | What happens |
|---|---|
| Read, search, list, `git status/diff/log`, create/edit/move files, `git add`, run project scripts and tests | Runs without asking |
| **Delete a file**, **`git commit`**, **run any command** other than harmless ones (`git status`, `git diff`, `node --version`, …) | **A dialog asks you first**; nothing runs until you click Allow |
| Read a file that may hold secrets (`.env`, `*.pem`, `id_rsa`, `.ssh/*`, …) | Asks first; search and file listings never show such files |
| Run project scripts after the AI edited `package.json`, `Makefile`, `pyproject.toml`, … | Asks first, because the script may no longer be yours |
| Write anything inside `.git/` (hooks run code) | Always refused |

Approval is a one-time code only the extension holds, valid for that exact action for two minutes; the
AI cannot grant it to itself. If you press Cancel the AI is told not to retry.

**Modes.** Set them in `config.json` (created by the launcher), under `mcpServers.vscode.env`; the launcher keeps them:

```json
"vscode": { "command": "...", "args": ["..."], "env": {
  "SNAPGENT_POLICY": "standard",
  "SNAPGENT_ALLOWED_COMMANDS": "cargo,make"
} }
```

- `standard` (default): the table above.
- `readonly`: observe only; every write, command and commit is refused.
- `trusted`: never asks (only the `.git` rule remains). Use it only on throwaway projects.
- `SNAPGENT_ALLOWED_COMMANDS`: bare program names that may run without asking.

This is defence in depth, not a sandbox: an AI that can write code and run your tests can run code.
The dialog keeps the dangerous one-liners visible to you.

---

## `08` &nbsp; Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| snapgentV3 bar is missing | Extension is disabled or site access is blocked | Check the extension is enabled and allowed on the current AI chat site, then reload the tab |
| Bridge is offline | Bridge is not running | Start `snapgent.exe` (Windows), `./snapgent` (Linux) or `python3 server/snapgent.py` (macOS) |
| Popup says *Approve in the bridge terminal* | This extension has not been approved yet | Answer `y` in the terminal running the bridge (only if it is your own extension); to reset, delete `trusted_origins.json` |
| AI replies without using tools | Provider/model stopped following commands | Remind it to use snapgentV3 commands or start a new chat |
| VS Code target is unavailable | The bridge is offline or the release is incomplete | Start `snapgent` and keep the project open in VS Code |
| A configured MCP server is missing from the target dropdown | The server was switched off in the **MCP servers** panel, or the extension is outdated | Open **MCP servers** from the ⋯ menu on the snapgent bar and tick the server, then reload the extension in `chrome://extensions` and refresh the chat tab |
| Target dropdown closes or the click does nothing | Older extension versions redrew the menu during status updates | Update to the latest release and reload the extension |

---

<div align="center">

**Built for creators who want to spend more time making.**

[Latest release V3.9.4](https://github.com/zoelfikarshomelab/snapgent-connector/releases/tag/V3.9.4) · [Issues](https://github.com/zoelfikarshomelab/snapgent-connector/issues) · [License](LICENSE)

Based on [snapgent-connector](https://github.com/herdodp/snapgent-connector) by [herdodp](https://github.com/herdodp), the original project. Released under the same GPL-3.0 license.

</div>
