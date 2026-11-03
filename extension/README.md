# snapgentV3 Free - AI Roblox Studio Agent (ChatGPT, Claude, DeepSeek, Gemini, Grok, Kimi, GLM, Qwen, Arena, Meta AI, Ptero)

Control Roblox Studio with AI, for free. snapgentV3 turns a normal AI chat (ChatGPT, Claude, DeepSeek, Google Gemini, Grok, Kimi, GLM, Qwen, Arena, Meta AI, or Ptero) into an agent that builds and scripts your Roblox game for you: just describe what you want, and it reads/edits scripts, runs Luau, inspects the game tree, and generates assets directly in Roblox Studio. No API key, no terminal, no coding required.

It's a Chrome/Edge browser extension plus a small local bridge that connects the chat to Roblox Studio or VS Code through MCP. **DeepSeek is the recommended provider.** ChatGPT, Claude, Gemini, Grok, Kimi, GLM, Qwen, Arena, Meta AI and Ptero also work. Grok requires signing in to xAI. On ChatGPT and Claude, screenshots and image input are disabled in this integration. ChatGPT also summarises its own context in long sessions, so snapgentV3 re-states its operating instructions periodically to stop it forgetting it can run commands. Gemini and Kimi can be less stable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes reaches for its own native tools instead of the Roblox commands. On Arena, keep the mode dropdown on **Direct** (snapgentV3 only supports Direct mode).

VS Code is the default **MCP target**. The bridge can start before VS Code, but open the intended project folder in VS Code before clicking **Start** in the chat bar. You can switch to Roblox Studio in the chat bar when its MCP server is enabled. The AI selector beside it opens the supported chat providers.

## Setup

**Load the extension manually (Edge or Chrome):**
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select `dist/chrome` (run `npm install && npm run build` first)
5. The extension is now active

**Then set up the Bridge:**
1. **Download the Bridge** from the [SnapgentV3 release](https://github.com/herdodp/snapgent-connector/releases/tag/V3)
2. **Run the Bridge** - on Windows, double-click `snapgent.exe`; on Linux, run `./snapgent`; on macOS, run `python3 server/snapgent.py` (Python 3.9+, `pip install websockets`). It configures the VS Code MCP server itself and can run before VS Code is open. Open the project folder in VS Code before clicking **Start** in the chat bar. Roblox Studio is optional: open a place and enable **Assistant AI** > **...** > **Manage MCP Servers** > **Enable Studio as MCP Server** to use that target too.
5. **Go to https://chat.deepseek.com** (recommended), https://chatgpt.com, https://claude.ai, https://gemini.google.com, https://grok.com, https://www.kimi.ai or https://kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, https://www.meta.ai, or https://ptero.pro, open a new chat (only works on these exact addresses; sign in to Grok first; on Arena use Direct mode)
6. Click **Start session** in the snapgentV3 panel
7. Type what you want to build

## Architecture (for contributors)

One content script (`src/entry/content.js`) composes the page modules in `src/page`, which wire the pure `domain` and the `application`
use cases to this page; a chat site is read from a profile the user teaches (calibration). See
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the layers and [docs/CALIBRATION.md](../docs/CALIBRATION.md) for calibration.

```bash
npm install && npm run build   # dist/chrome and dist/firefox
npm test                       # unit + integration tests
npm run lint
```
