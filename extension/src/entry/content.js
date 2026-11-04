// SPDX-License-Identifier: GPL-3.0-or-later
// The content script: turns a chat site into a VS Code agent. Only composes the page modules (src/page); each does one job and
// reaches the others through the objects passed to it. Anything that reads the site goes through `provider`.

import { PartQueue, ServerDirectory } from "../application/index.js";
import defaultCalibrations from "../../profiles/default-calibrations.json";
import { createAttachments } from "../page/attachments.js";
import { createAtPopup } from "../page/at-popup.js";
import { createAutoResume } from "../page/auto-resume.js";
import { createBar } from "../page/bar.js";
import { createBatchJobs } from "../page/batch-jobs.js";
import { createBridgeStatus } from "../page/bridge-status.js";
import { createCalibrationActions } from "../page/calibration-actions.js";
import { createChat } from "../page/chat.js";
import { createDiagnostics, watchForStalls } from "../page/diagnostics.js";
import { createExtensionBridge } from "../page/extension-bridge.js";
import { createLoop } from "../page/loop.js";
import { createMessageBudget } from "../page/message-budget.js";
import { startPageWatch } from "../page/page-watch.js";
import { createPromptResend } from "../page/prompt-resend.js";
import { createPreferences } from "../page/preferences.js";
import { createProvider } from "../page/provider.js";
import { createSession } from "../page/session.js";
import { createSettings } from "../page/settings.js";
import { createState } from "../page/state.js";
import { createStop } from "../page/stop.js";
import { createStorage } from "../page/storage.js";
import { createTools } from "../page/tools.js";
import { createTurns } from "../page/turns.js";
import { installUserInput } from "../page/user-input.js";
import { createVisibility } from "../page/visibility.js";

const storage = createStorage();
const state = createState();
let record = () => {};
const diag = (event, data) => record(event, data);
const provider = createProvider({ document, location, storage, diag, defaults: defaultCalibrations });
record = createDiagnostics({ provider, state, document, window });
watchForStalls({ diag, state, setInterval });

// The bar is made after the parts it shows; the parts that need it reach it through this.
let bar;
const redraw = () => { if (bar) bar.render(); };
const notify = (level, title, text) => bar.banner(level, title, text);

const send = createExtensionBridge();
const settings = createSettings({ storage, location, onChange: redraw });
const serverDirectory = new ServerDirectory({ store: storage, liveServers: () => state.bridge.servers || [], onChange: redraw, log: (...args) => console.warn("[snapgentV3]", ...args) });
const visibility = createVisibility({ document, state, diag, onParkChange: redraw });
const tools = createTools({ send, provider, state, settings, serverDirectory, visibility, storage, diag, banner: notify });
const bridgeStatus = createBridgeStatus({ state, settings, tools, send, bar: () => bar, diag });
const calibration = createCalibrationActions({ document, location, provider, state, storage, settings, toast: (text) => bar.toast(text) });

const preferences = createPreferences({ storage, state });
let stop;
let session;
let attachments;
bar = createBar({
  document, window, provider, state, settings, serverDirectory, tools, monitor: bridgeStatus.monitor, storage, preferences, send, calibration,
  files: { list: () => attachments.listFiles(), insert: (paths) => attachments.insert(paths), canList: () => attachments.canList() },
  onStart: () => session.start(),
  onStop: () => stop.stopLoop(),
});

const chat = createChat({ document, provider, state, visibility, catalogue: tools.catalogue, diag, cover: bar.cover, banner: notify });
const { turnKey, executed } = createTurns({ provider });
const budget = createMessageBudget({ storage, hostname: location.hostname, provider, diag });
const resend = createPromptResend({ provider, state, storage, systemPrompt: tools.systemPrompt, limit: budget.limit, chat, diag });
const parts = new PartQueue();
const loop = createLoop({ state, provider, tools, chat, bar, visibility, executed, budget, jobs: createBatchJobs({ storage, provider, turnKey }), resend, parts, diag });
session = createSession({ state, provider, tools, chat, bar, reminder: loop.reminder, limit: budget.limit, storage, settings, serverDirectory, diag });
stop = createStop({ document, state, provider, bar, diag });

let userInput;
attachments = createAttachments({ provider, state, tools, chat, bar, budget, parts, preferences, startTurn: (base) => userInput.startTurn(base), diag });
userInput = installUserInput({ document, state, provider, bar, resend, loop, takeOver: attachments.takeOver, diag });
createAtPopup({ document, window, root: bar.root, state, settings, provider, attachments, toast: bar.toast, diag });
createAutoResume({ document, state, provider, executed, loop, diag });
startPageWatch({ document, window, provider, session, bar });
resend.hydrate();
settings.ready.then(bridgeStatus.start);
console.log(`[snapgentV3] content script ready (provider: ${provider.id})`);
