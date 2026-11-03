// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses snapgentV3 commands (ZSParse), asks the
// background worker to execute them on the local MCP bridge (VS Code), and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = P.timings;
  const { feedbackIsError } = ZSDomain;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[snapgentV3]", ...a);

  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND && P.id !== "deepseek") return Promise.resolve();
    const [lo, hi] = P.id === "deepseek" ? [1500, 4000] : SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[zs-diag]") or window.__zsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    const snap = { ...P.snapshot(), gen: P.isGenerating(), run: A.running };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }
  P.init({ diag });

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  // GitHub releases page - where users download the Bridge + start.bat.
  const GITHUB_URL = "https://github.com/herdodp/snapgent-connector";
  // AI chat sites snapgentV3 works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const AI_SITES = [
    // { name: "DeepSeek", url: "https://chat.deepseek.com/" }, // hidden from UI bar (disabled, not deleted)
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Claude", url: "https://claude.ai/new" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.ai/" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/text/direct" },
    { name: "Meta AI", url: "https://www.meta.ai/" },
    { name: "Ptero", url: "https://ptero.pro/" },
    { name: "Grok", url: "https://grok.com/" },
    { name: "Mistral", url: "https://chat.mistral.ai/code" },
  ];
  const TARGET_STORAGE_KEY = "zsSelectedMcpTarget";
  let selectedTargetId = "vscode";
  try {
    chrome.storage.local.get(TARGET_STORAGE_KEY, (result) => {
      const saved = result && result[TARGET_STORAGE_KEY];
      if (typeof saved === "string" && saved) {
        selectedTargetId = saved;
        if (ui.setTarget) {
          ui.setTarget(saved);
          bg({ type: "status" }).then((status) => status && ui.setStatus(status));
        }
      }
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load selected MCP target:", error);
  }

  // ── MCP servers: names, enable/disable toggles, custom prompt (src/application/server-directory.js) ──
  // A server that was never toggled counts as enabled. Disabled servers are hidden from the target dropdown AND
  // filtered out of everything the AI reads (tool lists, list_mcp_servers, list_commands), so their schemas never cost tokens.
  const { ServerDirectory } = ZSApp;
  const serverDirectory = new ServerDirectory({
    store: {
      get: (key) => new Promise((resolve) => { try { chrome.storage.local.get(key, (r) => resolve(r && r[key])); } catch { resolve(undefined); } }),
      set: (key, value) => { try { chrome.storage.local.set({ [key]: value }); } catch {} },
    },
    liveServers: () => (A.bridge && A.bridge.servers) || [],
    onChange: () => { if (typeof ui !== "undefined" && ui.setTarget) ui.setTarget(selectedTargetId); },
    log: (...args) => console.warn("[snapgentV3]", ...args),
  });
  const isMcpEnabled = (id) => serverDirectory.isEnabled(id);

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. a
    // command that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see PromptResender).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // A custom MCP tool's name tells us nothing about returning images, so we
    // can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
  };

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // Park until the AI tab is the FOREGROUND tab of its window again (or the user
  // halts). Deliberately has NO time cap: a tab minimized/backgrounded for an
  // hour must resume cleanly, not silently time out into a "could not send /
  // not run" failure. (A plain waitFor with a finite timeout returned false on a
  // long minimize, which broke the send loop and ended the agent loop.) Returns
  // false ONLY if the user stopped while we were parked, so callers can break.
  // EVENT-DRIVEN, not polled. A chained setTimeout loop is subject to Chrome's
  // "intensive throttling": once a tab has been hidden >5 min, chained timers are
  // clamped to ONE tick per minute, so a sleep(300) poll could take up to a full
  // minute to notice the tab came back - the user sees the bar sit on "Paused"
  // long after they returned. visibilitychange fires immediately on unhide, so we
  // race it against a slow stop-poll (the stop path is not latency-critical).
  async function waitVisible() {
    if (!document.hidden || A.stop) return !A.stop;
    A.parked = true;
    try { ui.setStarting(); } catch {}
    try {
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = () => { if (!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        // Safety net only: covers a stop click while parked, and the (unlikely)
        // case of a missed visibilitychange event.
        const iv = setInterval(() => { if (A.stop || !document.hidden) done(); }, 1000);
      });
    } finally {
      A.parked = false;
      try { ui.setStarting(); } catch {}
    }
    return !A.stop;
  }

  // Park while the tab is hidden and report how long we were parked, so callers
  // can slide their timers forward by that amount. Without this, every deadline
  // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
  // ticking while nothing can be read - which is what turned "user switched to
  // another app for 5 minutes" into "No response from <site>, the loop has stopped"
  // and left the pending command showing a grey "not run".
  async function parkHidden() {
    if (!document.hidden || A.stop) return 0;
    const t0 = Date.now();
    await waitVisible();
    const parked = Date.now() - t0;
    diag("park.resumed", { parkedMs: parked });
    // Give the site a beat to repaint: a tab that was hidden has no layout, so
    // the first reads after unhide can come back stale/blank.
    if (!A.stop) await sleep(400);
    return parked;
  }

  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER (src/application/response-watcher.js), wired via ports
  // ════════════════════════════════════════════════════════════════════════
  const { ResponseWatcher } = ZSApp;
  // Optional provider capabilities are passed through only when the provider implements them.
  const providerMethod = (name) => (typeof P[name] === "function" ? (...args) => P[name](...args) : undefined);
  const replyReader = {
    isGenerating: () => P.isGenerating(),
    readAssistant: () => P.readAssistant(),
    lastAssistantId: providerMethod("lastAssistantId"),
    assistantCount: () => P.assistantCount(),
    scanError: () => P.scanError(),
    turnHalted: (item) => P.turnHalted(item),
    isTooLongMsg: (text) => P.isTooLongMsg(text),
    findContinueBtn: () => P.findContinueBtn(),
    reliableCounts: P.reliableCounts,
    replyUnsettled: providerMethod("replyUnsettled"),
    isComparisonTurn: providerMethod("isComparisonTurn"),
    resolveComparison: providerMethod("resolveComparison"),
  };
  // What the page looks like, for diagnostics when the adapter cannot find what it expects: the element
  // chains around text we KNOW is there (our marker, the model's command) are exactly what is needed to
  // teach an adapter a new page layout.
  const layoutReport = () => ({
    provider: P.id,
    layout: typeof P.describeLayout === "function" ? P.describeLayout() : undefined,
    users: P.userCount(),
    assistants: P.assistantCount(),
    markerChain: ZSChat.describeAnchor(document, ZS.SYS_MARKER),
    replyChain: ZSChat.describeAnchor(document, '"command"'),
  });
  const responseWatcher = new ResponseWatcher({
    chat: replyReader,
    visibility: { isHidden: () => document.hidden, parkHidden: () => parkHidden() },
    isStopped: () => A.stop,
    sendToken: () => A.sendToken,
    clock: { now: () => Date.now(), sleep },
    timings: T,
    knowsTool: (name) => catalogue.knows(name),
    catalogueSize: () => catalogue.names().size,
    describeLayout: layoutReport,
    diag,
  });
  const waitForResponse = (base) => responseWatcher.wait(base);

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local snapgentV3 bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = (m) =>
    /Extension context invalidated|Receiving end does not exist|message port closed/i.test(m || "");

  function bg(msg) {
    return new Promise((resolve) => {
      const fail = (m) => resolve({
        ok: false,
        kind: isContextInvalidated(m) ? "stale-extension" : "disconnected",
        error: m,
      });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (e) {
        fail(String(e && e.message || e));
      }
    });
  }

  // Any tool from ANY connected server can turn out to return images, and its
  // name never reveals that in advance. Image results are caught generically at
  // the point results are handled (see the `r.images.length` branch) and turned
  // into a plain error on providers whose model cannot see images.
  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // A custom MCP tool's NAME reveals nothing about returning images, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The reload-proof signal is a fixed phrase in the feedback that carries an image (IMAGE_FEEDBACK_RE in
  // domain/tools/result-feedback.js, read by ui/turn-chips.js), so it is readable from the result turn's
  // text even when no loop is running.
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ zsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("zsImageTools", (r) => {
      if (r && Array.isArray(r.zsImageTools)) for (const n of r.zsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // ── Tool execution (src/application): wired to this page through ports ────
  const { ToolCatalogue, ToolRunner } = ZSApp;
  const { bareToolName } = ZSDomain;

  const bridgePort = {
    listTools: () => bg({ type: "list_tools" }),
    callTool: (request) => bg({ type: "call_tool", ...request }),
  };
  const sessionPort = {
    target: () => selectedTargetId,
    isEnabled: (id) => isMcpEnabled(id),
    servers: () => (A.bridge && A.bridge.servers) || [],
    supportsVision: () => !!P.supportsVision,
    isStopped: () => A.stop,
  };
  const visibilityPort = {
    isHidden: () => document.hidden,
    waitUntilVisible: () => waitVisible(),
  };
  const sinkPort = {
    // Stash the images and let the provider attach them as the LAST step before
    // the send click (typing the text later would sever the composer binding).
    images: (images, toolName) => { ui.showImages(images, toolName); A.pendingImages = images; },
    staleExtension: () => ui.banner("warn", "Reload page", "Updated. Press F5."),
    diag,
  };
  const catalogue = new ToolCatalogue({ bridge: bridgePort, session: sessionPort, diag });
  // Risky actions (delete, commit, arbitrary commands, reading secrets) need the user's approval
  // (src/ui/confirm-dialog.js: a top-layer dialog in a closed shadow root that ignores synthetic clicks).
  const confirmPort = ZSUi.createConfirmDialog();
  // How the VS Code server treats risky actions, chosen in the bar: plan (read only), manual (asks), auto (never asks).
  // The same on every site; kept in storage; sent with each call (the model cannot set it).
  let approvalMode = "manual";
  try {
    chrome.storage.local.get("zsApprovalMode", (r) => { if (r && ZSUi.APPROVAL_MODES.some((m) => m.id === r.zsApprovalMode)) { approvalMode = r.zsApprovalMode; scheduleSweep(); } });
  } catch {}
  const toolRunner = new ToolRunner({
    bridge: bridgePort, catalogue, session: sessionPort, visibility: visibilityPort, sink: sinkPort, confirm: confirmPort,
    approvalMode: () => approvalMode,
  });
  const runTool = (call) => toolRunner.run(call);
  const activeTools = () => catalogue.active();

  // ── Sending a message (src/application/message-sender.js) ────────────────
  const { MessageSender } = ZSApp;
  const sendEffects = {
    begin() { captureSendToken(); A.injecting = true; ui.inputCover(true); },
    // The very next NEW user turn is ours: preHideWholeItems masks it on creation instead of flashing the raw output.
    armPrehide(preUser) { A.injectPreUser = preUser; A.injectHideUntil = Date.now() + 2500; },
    // typeAndSend can block seconds uploading an image, past the first window.
    rearmPrehide() { A.injectHideUntil = Date.now() + 2500; },
    end() {
      // During Starting Up / the agent loop, that phase owns the cover; it stays up until the loop ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer (paused in a background tab).
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    },
  };
  const messageSender = new MessageSender({
    page: {
      lastAssistant: () => P.lastAssistant(),
      streamLen: (item) => P.streamLen(item),
      isGenerating: () => P.isGenerating(),
      isBusyNow: () => P.isBusyNow(),
      assistantCount: () => P.assistantCount(),
      userCount: () => P.userCount(),
      editorText: () => P.editorText(),
      typeAndSend: (text, images) => P.typeAndSend(text, images),
    },
    visibility: visibilityPort,
    effects: sendEffects,
    clock: { sleep, waitFor },
    isStopped: () => A.stop,
    beforeSend: () => jitterBeforeSend(),
    retryLimit: P.sendRetryLimit,
    notify: { banner: (level, title, text) => ui.banner(level, title, text) },
    diag,
  });
  const submitAndGetBase = (text, images) => messageSender.submit(text, images);

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP (src/application/agent-loop.js), wired to this page via ports
  // ════════════════════════════════════════════════════════════════════════
  const { AgentLoop, ToolReminder } = ZSApp;
  const toolReminder = new ToolReminder();

  const loopChat = {
    next: (base) => waitForResponse(base),
    submit: (text, images) => submitAndGetBase(text, images),
    isHalted: (item) => P.turnHalted(item),
    resumeTruncated: async () => !!(P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)),
  };

  const loopView = {
    banner: (level, title, text) => ui.banner(level, title, text),
    toast: (text) => ui.toast(text),
    keepCover: () => ui.inputCover(true),
    // Which command is running now, on the composer cover.
    progress: (text) => ui.inputCoverLabel(text),
    // The command turn ended in a parse error and NEVER ran: paint its chip as an error
    // (owned, so the sweep will not repaint it with the green check it stamps on any command turn).
    parseErrorChip: ({ item, name, detail, category }) => decorate.toolBox(item, name, "err", detail, true, "", category),
    toolRunning(item, call, category, { arg, body }) {
      decorate.toolBox(item, call.tool, "run", arg, true, body, category);
      A.toolSettle = null; // a fresh call: no settled outcome yet
      A.toolRunning = true;
      A.toolStart = Date.now();
      A.toolName = call.tool;
      A.toolItem = item;
      A.toolArg = arg;
    },
    toolFinished: () => { A.toolRunning = false; },
    toolStopped(item, call, category) {
      // MARK the turn so the sweep classifier never repaints it done once generation ends.
      if (item) { item.dataset.zStopped = "1"; haltedTurns.remember(item); }
      decorate.toolBox(item, call.tool, "err", "stopped", true, "", category);
    },
    toolSettled(item, call, outcome) {
      decorate.toolBox(item, call.tool, outcome.phase, outcome.summary, true, outcome.body, outcome.category);
      // Snapshot the settled outcome: if the site swaps this turn's DOM node while we wait for the
      // model's next turn, the sweep re-owns the fresh node with this outcome instead of re-spinning.
      A.toolSettle = {
        phase: outcome.phase, detail: outcome.summary, body: outcome.body, category: outcome.category,
        count: P.assistantCount(),
        // Node identity of the settled turn (virtualization-proof), when the provider exposes it.
        id: P.lastAssistantId ? P.lastAssistantId() : undefined,
      };
    },
  };

  const loopLifecycle = {
    start() {
      A.running = true;
      A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
      A.stop = false;
      A.stopping = false; // never inherit a stale "Stopping…" from a Stop click before the loop started
      A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
      ui.showStop(true);
      P.setInputLock(true); // prevent user from typing while the agent is active
      ui.inputCover(true); // keep the "Agent is working" cover up for the WHOLE loop
    },
    end() {
      A.running = false;
      A.stop = false;
      // Keep "Stopping…" while the site's stream is still draining after a user stop, otherwise the
      // next sweep restores a clickable "■ Stop" for the last beat of the dying stream.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      ui.inputCoverLabel("");
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
    },
    isStopped: () => A.stop,
    halt: () => { A.stop = true; },
  };

  const loopTools = {
    hasCatalogue: () => catalogue.hasAny(),
    isImageTool: (bareName) => A.imageTools.has(bareName),
    learnImageTool: (name) => rememberImageTool(name),
    hasPendingImages: () => !!(A.pendingImages && A.pendingImages.length),
    takePendingImages: () => { const images = A.pendingImages; A.pendingImages = null; return images; },
    // Scoped to the selected target, like list_commands: all servers merged flat would bloat the context.
    reminderText: () => ZS.toolsReminder(activeTools(), ui.getTargetName(), selectedTargetId),
  };

  // ── How big ONE message into the chat may be ─────────────────────────────
  // The slider in the toolbar popup (zsMaxPromptChars) sets it; a site's own cap (P.sendCharBudget) and what this
  // host once refused as "too long" can only lower it. The loop splits it between the results of one reply.
  let promptSetting = ZS.DEFAULT_PROMPT_CHARS;
  let learnedCap = Infinity;
  const capKey = `zsLearnedCap:${location.hostname}`;
  try {
    chrome.storage.local.get(["zsMaxPromptChars", capKey], (r) => {
      if (!r) return;
      promptSetting = ZS.clampPromptChars(r.zsMaxPromptChars);
      if (r[capKey] > 0) learnedCap = r[capKey];
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.zsMaxPromptChars) { promptSetting = ZS.clampPromptChars(changes.zsMaxPromptChars.newValue); learnedCap = Infinity; try { chrome.storage.local.remove(capKey); } catch {} }
    });
  } catch {}
  const messageLimit = () => ZS.effectiveLimit(promptSetting, Math.min(P.sendCharBudget || Infinity, learnedCap));
  // Characters sent so far in this conversation (history counts against the context as well); kept per conversation.
  const volume = { key: "", total: 0 };
  const VOLUMES_KEY = "zsVolumes";
  const sentVolume = (chars) => {
    const key = P.conversationKey() || "new";
    if (volume.key !== key) {
      volume.key = key;
      volume.total = 0;
      try {
        chrome.storage.local.get(VOLUMES_KEY, (r) => { const saved = r && r[VOLUMES_KEY] && r[VOLUMES_KEY][key]; if (volume.key === key && saved > 0) volume.total += saved; });
      } catch {}
    }
    volume.total += chars;
    try {
      chrome.storage.local.get(VOLUMES_KEY, (r) => {
        const all = { ...((r && r[VOLUMES_KEY]) || {}) };
        delete all[key];
        all[key] = volume.total;
        const keep = Object.keys(all).slice(-200);
        chrome.storage.local.set({ [VOLUMES_KEY]: Object.fromEntries(keep.map((k) => [k, all[k]])) });
      });
    } catch {}
    return volume.total;
  };
  const messageBudget = {
    limit: messageLimit,
    sent: sentVolume,
    // The site refused a message of this size as too long: stay well under it from now on (until the slider moves).
    tooLong: (chars) => {
      if (!(chars > 0)) return;
      learnedCap = Math.max(ZS.MIN_PROMPT_CHARS, Math.floor(chars * 0.6));
      try { chrome.storage.local.set({ [capKey]: learnedCap }); } catch {}
      diag("budget.learned", { chars, cap: learnedCap });
    },
  };

  // The id of the batch being run for a reply, kept across a page reload: the reply is run again after one, and under the
  // same id the VS Code server answers the commands that already ran instead of running them twice (see BatchRunner).
  // It is dropped when the batch is answered or stopped, so running the same reply later is a new batch.
  const BATCHES_KEY = "zsBatches";
  const BATCH_LIFETIME_MS = 15 * 60 * 1000;
  const batchKey = (item) => `${P.conversationKey() || "new"}|${turnKey(item)}`;
  const readBatches = () => new Promise((resolve) => {
    try { chrome.storage.local.get(BATCHES_KEY, (r) => resolve((r && r[BATCHES_KEY]) || {})); } catch { resolve({}); }
  });
  const writeBatches = (all) => { try { chrome.storage.local.set({ [BATCHES_KEY]: all }); } catch {} };
  const batchJobs = {
    async begin(item) {
      const now = Date.now();
      const all = Object.fromEntries(Object.entries(await readBatches()).filter(([, batch]) => now - batch.at < BATCH_LIFETIME_MS));
      const key = batchKey(item);
      if (!all[key]) all[key] = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: now };
      writeBatches(Object.fromEntries(Object.entries(all).slice(-50)));
      return all[key].id;
    },
    async end(item) {
      const all = await readBatches();
      delete all[batchKey(item)];
      writeBatches(all);
    },
  };

  const loop = new AgentLoop({
    jobs: batchJobs,
    budget: messageBudget,
    chat: loopChat,
    view: loopView,
    lifecycle: loopLifecycle,
    visibility: visibilityPort,
    runner: toolRunner,
    tools: loopTools,
    memory: { executed: (item) => executedTurns.remember(item) },
    // A result becomes a turn, so it counts toward the system-prompt re-statement budget and may carry it.
    outbox: {
      prepare: (text) => { promptResender.bump("results"); return promptResender.attach(text); },
      reserve: () => promptResender.reserve(),
    },
    reminder: toolReminder,
    // Nothing observable changing while the tab is visible and no tool runs means the loop is stuck.
    activity: {
      signature: () => [P.assistantCount(), P.userCount(), P.streamLen ? P.streamLen() : 0, P.isGenerating() ? 1 : 0].join("|"),
      isPaused: () => document.hidden || A.parked || A.toolRunning || A.injecting,
    },
    timers: window,
    displayName: () => P.displayName,
    diag,
  });
  const agentLoop = (base) => (A.running ? undefined : loop.run(base).catch((e) => {
    // loop.run reports its own failures; this only catches what happens before its try block.
    diag("loop.crash", { msg: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 300) });
  }));

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    haltedTurns.remember(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const { TurnMemory } = ZSApp;
  const turnMemoryPorts = {
    conversationKey: () => P.conversationKey(),
    keyOf: turnKey,
    isRendered: (item) => assistantIdx(item) >= 0,
    textOf: (item) => P.itemText(item),
  };
  const haltedTurns = new TurnMemory(turnMemoryPorts);
  const executedTurns = new TurnMemory(turnMemoryPorts);

  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      haltedTurns.remember(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", ZS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → "⏳ Stopping…", disabled
    P.stopGeneration();
    ui.toast("Stopping…");
  }

  // Skills (.snapgent/skills/<name>/SKILL.md in the workspace + a global library): src/application/skills-service.js
  const { SkillsService } = ZSApp;
  const skillsService = new SkillsService({
    store: {
      get: (key) => new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r && r[key]))),
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
    },
    findTool: (bareName) => activeTools().find((tool) => bareToolName(tool.name) === bareName),
    callTool: (name, args, timeout) => bg({ type: "call_tool", name, arguments: args, timeout }),
    diag,
    log,
  });

  // The full system prompt for the CURRENT provider and user settings. One definition, used both by the
  // bootstrap and by the periodic re-injection, so the two can never drift apart.
  function systemPrompt() {
    return ZS.buildSystemPrompt({
      siteName: P.displayName,
      customPrompt: serverDirectory.customPrompt,
      providerNotes: P.promptExtra || "",
      targetServer: selectedTargetId,
      targetName: ui.getTargetName(),
      skills: skillsService.enabled,
    });
  }

  // ── Periodic system-prompt re-injection (opt-in per provider; src/application/prompt-resender.js) ──
  // Some sites summarise their own context mid-conversation; the model then forgets that an extension
  // runs its commands. Providers that need it set `resendSystemEvery`; the whole prompt rides on the next
  // injected tool result, with a fallback that sends it as its own masked turn (see the interval at the
  // bottom of this file).
  const { SysTally, PromptResender } = ZSApp;
  const sysTally = new SysTally({
    storage: {
      get: (key) => new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r && r[key]))),
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
    },
    conversationKey: () => P.conversationKey(),
    enabled: !!P.resendSystemEvery,
  });
  const promptResender = new PromptResender({
    tally: sysTally,
    everyUsers: P.resendSystemEvery || 0,
    systemPrompt: () => systemPrompt(),
    // What is visibly on screen is a floor under the stored tally (a session adopted from another device, cleared storage).
    domCounts: () => {
      const items = P.allItems();
      return ZSDomain.countSinceLastMarker(items.length, (i) => ({
        // The bootstrap turn and every rider both carry the marker: either means the rules were fully stated here.
        text: P.classifyText(items[i], ".zs-chip"),
        isUser: P.isUserItem(items[i]),
      }));
    },
    charBudget: () => messageLimit(),
    onResent: (at) => { A.sysResendAt = at; },
    diag,
  });

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  // Start flow (src/application/session-starter.js), wired to this page's flags and UI.
  const { SessionStarter } = ZSApp;
  const sessionLifecycle = {
    canStart: () => !A.running && !A.starting,
    begin() {
      A.userStopped = false;
      A.stop = false; // clear any halt left by a prior aborted bootstrap
      // Snapshot any turn already on screen (a reload-restored generation): the auto-resume watchdog
      // refuses to run a tool from this baseline turn, so a restored command cannot leak into the new chat.
      A.bootBaselineId = P.lastAssistantId ? P.lastAssistantId() : null;
      A.starting = true;
      const myGeneration = ++A.startGen; // identity of THIS bootstrap
      A.startingKey = null; // unknown until the conversation gets an id
      toolReminder.reset(); // fresh reminder cadence for the new session
      ui.setStarting(true);
      ui.updateStartGate(); // refresh the bar into its "starting" state
      P.setInputLock(true); // block user input during bootstrap
      ui.inputCover(true); // cover the composer ("Working…") for the WHOLE Starting Up
      return () => A.startGen === myGeneration; // false once superseded/aborted
    },
    markStarted() {
      A.started = true;
      sessionTracker.remember(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
    },
    end(alive) {
      // Only tear down our OWN starting state. If superseded (the user opened another chat), the newer
      // flow / syncSessionState owns it now.
      if (!alive()) return;
      A.starting = false;
      A.startingKey = null;
      ui.setStarting(false);
      ui.inputCover(false);
      P.setInputLock(false);
      decorate.sweep();
    },
  };
  const sessionStarter = new SessionStarter({
    session: sessionLifecycle,
    page: {
      isEmpty: () => P.chatIsEmpty(),
      isStarted: () => A.started,
      ensureComposerReady: (reason) => P.ensureComposerReady(reason),
      displayName: () => P.displayName,
    },
    target: {
      id: () => selectedTargetId,
      name: () => ui.getTargetName(),
      bridgeConnected: () => !!(A.bridge && A.bridge.connected),
      serverAlive: () => {
        const server = ((A.bridge && A.bridge.servers) || []).find((item) => item.id === "vscode");
        return !!(server && server.alive);
      },
    },
    catalogue,
    callTool: (name, args, timeout) => bg({ type: "call_tool", name, arguments: args, timeout }),
    skills: skillsService,
    systemPrompt: () => systemPrompt(),
    chat: loopChat,
    runner: toolRunner,
    initialContext: { limit: messageLimit },
    view: {
      toast: (text) => ui.toast(text),
      banner: (level, title, text) => ui.banner(level, title, text),
      showStartingChip: () => decorate.sweep(),
      handshake: (item, phase, detail) => decorate.toolBox(item, "Loading commands", phase, detail, true),
    },
    layout: {
      // Our prompt must show up as a user turn carrying the session marker: that is how it gets hidden.
      sentMessageVisible: () => waitFor(
        () => P.allItems().some((item) => P.isUserItem(item) && P.classifyText(item, ".zs-chip").includes(ZS.SYS_MARKER)),
        5000,
      ),
      describe: layoutReport,
    },
    isStopped: () => A.stop,
    diag,
  });
  const startSession = () => sessionStarter.start();

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__zsChip;
  }

  // The chat is shown exactly as the site draws it (no chips, nothing hidden): what matters is that replies reach the tools
  // and results come back. Chips and hiding raw command blocks are per-site fragile and are off.
  const DECORATE = false;

  // Placing and rebuilding chips: src/ui/chip-painter.js. decorate adds the classification that decides what each turn shows.
  const decorate = {
    ...ZSUi.createChipPainter({ document, provider: P, diag, plain: !DECORATE }),

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1. Turns WE wrote: the system prompt (and its mid-session re-statements) and injected tool
      //    results. What chip they get is decided from their text alone (src/ui/turn-chips.js).
      const systemTurn = ZSUi.describeSystemTurn(txt, { starting: A.starting });
      if (systemTurn) {
        if (systemTurn.kind === "resend") {
          if (item.dataset.zs !== "resend" || chipGone) {
            this.chip(item, systemTurn.chip);
            item.dataset.zs = "resend";
            item.dataset.zphase = "remind";
          }
        } else if (item.dataset.zs !== "sys" || item.dataset.zphase !== systemTurn.phase || chipGone) {
          this.chip(item, systemTurn.chip);
          item.dataset.zphase = systemTurn.phase;
        }
        return;
      }
      const resultTurn = P.isUserItem(item) ? ZSUi.describeResultTurn(txt) : null;
      if (resultTurn) {
        // A feedback that carried an image is learned (persisted) so its command turn above AND the next
        // call of that tool get the "screen" chip even with no loop running.
        if (resultTurn.hasImage && resultTurn.toolName) rememberImageTool(resultTurn.toolName);
        if (item.dataset.zsig !== resultTurn.signature || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, resultTurn.chip);
          item.dataset.zsig = resultTurn.signature;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.zsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !ZSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".zs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ? "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real snapgentV3 session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as textShowsSession: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // The decisions below are pure and live in src/ui/command-phase.js; this gathers the facts and paints.
        // After a post-stop regenerate the site still shows the OLD command (see zRegenLen in regenResume):
        // keep the coherent red "stopped" look until the content is replaced or a short window elapses.
        if (item.dataset.zRegenLen) {
          if (ZSUi.holdsRegenerateLook({
            baseLength: Number(item.dataset.zRegenLen), armedAt: Number(item.dataset.zRegenAt || 0), textLength: txt.length, now: Date.now(),
          })) {
            this.toolBox(item, ZSParse.toolNameFromText(txt) || "command", "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        const isLast = item === P.lastAssistant();
        const generating = isLast && P.isGenerating();
        // The dataset marker alone is not enough (sites swap the node on re-render), so the off-DOM memory and the
        // userStopped latch count too; a turn generating again with no stop latch was regenerated, so its stale halt is dropped.
        const { regenerating, stopped } = ZSUi.haltState({
          userStopped: A.userStopped, isLast, generating, toolRunningOnThisTurn: A.running && A.toolItem === item,
          marked: item.dataset.zStopped === "1", remembered: haltedTurns.has(item, txt),
        });
        if (regenerating) { delete item.dataset.zStopped; haltedTurns.forget(item); }
        // Self-heal: a node swap wiped the marker - re-stamp it so the stop survives the next wipe of the latch.
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: ZSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call but the site swapped the node, wiping the chip, the zloop
        // ownership and the __zsChip opts: re-own it with the settled outcome instead of re-spinning it. "Same turn" is
        // node identity when the provider has lastAssistantId (virtualization-proof), else the assistant count.
        const settle = A.toolSettle;
        if (ZSUi.shouldReown({
          stopped, running: A.running, toolRunning: A.toolRunning, hasSettled: !!settle,
          sameTurn: !!settle && (settle.id !== undefined && P.lastAssistantId ? P.lastAssistantId() === settle.id : settle.count === P.assistantCount()),
          isLast, sameTool: ZSParse.toolNameFromText(txt) === A.toolName,
        })) {
          diag("chip.reown", { name: A.toolName, phase: settle.phase });
          this.toolBox(item, A.toolName, settle.phase, settle.detail, true, settle.body, settle.category);
          return;
        }
        // Every ALREADY-EXECUTED command turn is followed by its injected result, which separates the in-flight turn
        // from settled history without depending on the flickery lastAssistant().
        const nextText = next && P.isUserItem(next) ? P.classifyText(next, ".zs-chip") : "";
        const resultAfter = !!nextText && ZSParse.isInjectedFeedback(nextText);
        const verdict = ZSUi.commandPhase({
          stopped, isLast, generating, running: A.running, starting: A.starting, resultBelow: resultAfter,
          executedBefore: executedTurns.has(item, txt), resumeArmed: A.resumeArmed, resumeArmedAt: A.resumeArmedAt,
          lastGenAt: A.lastGenAt, freshMs: RESUME_FRESH_MS, now: Date.now(), dsml: ZSParse.DSML_RE.test(txt),
          errorBelow: resultAfter && feedbackIsError(nextText),
        });
        const { phase, detail, live, inFlight, resumeGrace, pendingExec } = verdict;
        if (verdict.errorSettled && item.dataset.zphase !== "err") diag("chip.errSettle", { name: ZSParse.toolNameFromText(txt) });
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with any image tool). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = ZSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".zs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              isLast && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast, resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: haltedTurns.has(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ? { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".zs-chip")) {
        const tx = item.querySelector(".zs-chip-tx");
        const name = ZSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.zs || "chip-only" });
        resetDecoration(item);
      }
    },

    // Takes off anything an earlier version painted, once; after that the page is not touched.
    undecorateAll() {
      if (this.cleaned) return;
      this.cleaned = true;
      for (const el of document.querySelectorAll(".zs-chip, .zs-hidden, .zs-tool-hide, .zs-cmd-mask")) {
        if (el.classList.contains("zs-chip")) el.remove();
        else el.classList.remove("zs-hidden", "zs-tool-hide", "zs-cmd-mask");
      }
    },

    sweep() {
      if (!DECORATE) { this.undecorateAll(); return; }
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".zs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".zs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let renderMode = () => {};
    let pinnedWorkspace = null;
    let toggleEl, stopFloatEl, root, bar, stateEl, actionBtn, stopBtn, targetSelect, switchBtn, menuEl, unstableEl, notifications;
    let targetBtn, targetMenuEl;
    let barRaf;
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    // Connection health and the VS Code workspace probe: src/application/bridge-monitor.js
    const { BridgeMonitor } = ZSApp;
    const bridgeMonitor = new BridgeMonitor({
      ensureTools: () => catalogue.ensure(false),
      activeTools,
      listRoot: (name, timeout) => bg({ type: "call_tool", name, arguments: { path: "." }, timeout }),
      isListTool: (name) => bareToolName(name) === "tree",
      onChange: () => renderBar(),
      log: (...args) => console.warn("[snapgentV3]", ...args),
    });

    // Placement maths lives in src/ui/menu-position.js; these only measure and apply.
    function positionMenu(anchor) {
      if (!menuEl || menuEl.hidden) return;
      ZSUi.applyMenuPlacement(menuEl, ZSUi.computeMenuPlacement({
        anchor, menuWidth: menuEl.offsetWidth, defaultWidth: 274, viewport: ZSUi.viewportOf(document, window), align: "right", roomAbove: 180,
      }));
    }

    // Where the bar sits (bottom or top right corner) and whether it is shown: the user's choice, the same on every site.
    let barPrefs = { corner: "bottom", hidden: false };
    try {
      chrome.storage.local.get("zsBarPrefs", (r) => { if (r && r.zsBarPrefs) barPrefs = { ...barPrefs, ...r.zsBarPrefs }; });
      chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.zsBarPrefs) barPrefs = { ...barPrefs, ...changes.zsBarPrefs.newValue }; });
    } catch {}
    function setBarPrefs(change) {
      barPrefs = { ...barPrefs, ...change };
      try { chrome.storage.local.set({ zsBarPrefs: barPrefs }); } catch {}
    }

    function build() {
      root = document.createElement("div");
      root.id = "zs-root";
      notifications = ZSUi.createNotifications({ root });
      // One consolidated status bar, anchored just above the site's composer
      // (positioned every frame by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites and options). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      root.innerHTML = `
        <div id="zs-bar">
          <span id="zs-state"></span>
          <button id="zs-action"></button>
          <button id="zs-stop" hidden>■ Stop</button>
          <select id="zs-target" aria-label="MCP target" hidden tabindex="-1">
            <option value="vscode">VS Code</option>
          </select>
          ${ZSUi.pillHtml({ id: "zs-mode-btn", nameId: "zs-mode-name", label: "Choose how risky actions are approved", title: "Plan: read only. Manual: asks first. Auto: never asks." })}
          ${ZSUi.pillHtml({ id: "zs-ws-btn", nameId: "zs-ws-name", label: "Choose the workspace folder", title: "Which folder the agent works in" })}
          ${ZSUi.pillHtml({ id: "zs-target-btn", nameId: "zs-target-name", label: "Choose MCP target", title: "Choose which MCP server receives commands", popup: "listbox" })}
          ${ZSUi.pillHtml({ id: "zs-switch", nameId: "zs-switch-name", label: "Switch AI and options", title: "Switch AI and options" })}
        </div>
        <button id="zs-stop-float" type="button" hidden>■ Stop</button>
        <button id="zs-toggle" type="button" aria-label="Show or hide snapgent"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></button>
        <div id="zs-menu" hidden></div>
        <div id="zs-target-menu" hidden></div>
        <div id="zs-mode-menu" hidden></div>
        <div id="zs-ws-menu" hidden></div>
        ${P.unstableWarning ? `<button id="zs-unstable" aria-label="Provider may be unstable" hidden>⚠ unstable</button>` : ""}
      `;
      document.documentElement.appendChild(root);
      bar = root.querySelector("#zs-bar");
      toggleEl = root.querySelector("#zs-toggle");
      toggleEl.addEventListener("click", (e) => { e.stopPropagation(); setBarPrefs({ hidden: !barPrefs.hidden }); });
      stateEl = root.querySelector("#zs-state");
      actionBtn = root.querySelector("#zs-action");
      stopBtn = root.querySelector("#zs-stop");
      targetSelect = root.querySelector("#zs-target");
      targetBtn = root.querySelector("#zs-target-btn");
      targetMenuEl = root.querySelector("#zs-target-menu");
      switchBtn = root.querySelector("#zs-switch");
      const swName = root.querySelector("#zs-switch-name");
      if (swName) swName.textContent = P.displayName || P.id;
      setTarget(selectedTargetId);
      targetSelect.addEventListener("change", () => {
        // Switching is always allowed (even while a session is running).
        // After the new target is persisted, reload the page so the whole
        // extension restarts cleanly against the newly selected MCP server.
        selectedTargetId = targetSelect.value || "vscode";
        const reloadPage = () => { try { location.reload(); } catch {} };
        try {
          chrome.storage.local.set({ [TARGET_STORAGE_KEY]: selectedTargetId }, reloadPage);
        } catch (error) {
          console.error("[snapgentV3] Could not save selected MCP target:", error);
          reloadPage();
        }
      });
      menuEl = root.querySelector("#zs-menu");
      // Custom MCP target dropdown (same look as the Switch AI menu). The hidden
      // <select> stays the data source so the existing change handler is reused.
      const targetTick = () => {
        if (targetMenuEl.hidden) return;
        positionTargetMenu();
        requestAnimationFrame(targetTick);
      };
      targetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menuEl) menuEl.hidden = true;
        targetMenuEl.hidden = !targetMenuEl.hidden;
        if (!targetMenuEl.hidden) {
          renderTargetMenu();
          positionTargetMenu();
          requestAnimationFrame(targetTick);
        }
      });
      document.addEventListener("click", (e) => {
        if (targetMenuEl.hidden) return;
        if (!targetMenuEl.contains(e.target) && !targetBtn.contains(e.target)) targetMenuEl.hidden = true;
      }, true);
      // The approval-mode pill (Plan / Manual / Auto) and its menu: same look and behaviour as the MCP target pill.
      const modeBtn = root.querySelector("#zs-mode-btn");
      const modeMenuEl = root.querySelector("#zs-mode-menu");
      renderMode = () => {
        const mode = ZSUi.APPROVAL_MODES.find((m) => m.id === approvalMode) || ZSUi.APPROVAL_MODES[1];
        root.querySelector("#zs-mode-name").textContent = mode.name;
        modeBtn.dataset.mode = mode.id;
        // Both pills only mean something for the VS Code server (other servers know nothing of modes or folders).
        const forVscode = selectedTargetId === "vscode";
        modeBtn.hidden = !forVscode;
        root.querySelector("#zs-ws-btn").hidden = !forVscode;
      };
      const positionModeMenu = () => {
        if (modeMenuEl.hidden) return;
        ZSUi.applyMenuPlacement(modeMenuEl, ZSUi.computeMenuPlacement({
          anchor: modeBtn.getBoundingClientRect(), menuWidth: modeMenuEl.offsetWidth, defaultWidth: 280,
          viewport: ZSUi.viewportOf(document, window), align: "right", roomAbove: 200,
        }));
        requestAnimationFrame(positionModeMenu);
      };
      async function chooseMode(id) {
        modeMenuEl.hidden = true;
        if (id === approvalMode) return;
        // Auto is the one choice that removes the safety net: ask once, in the page-proof dialog, before it takes effect.
        if (id === "auto" && !(await confirmPort.ask({
          description: "Switch to Auto? The agent will then delete files, make git commits and run commands in your project without asking you each time.",
          tool: "Approval mode", risk: "execute",
        }))) return;
        approvalMode = id;
        try { chrome.storage.local.set({ zsApprovalMode: id }); } catch {}
        renderMode();
      }
      modeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menuEl) menuEl.hidden = true;
        targetMenuEl.hidden = true;
        root.querySelector("#zs-ws-menu").hidden = true;
        modeMenuEl.hidden = !modeMenuEl.hidden;
        if (modeMenuEl.hidden) return;
        modeMenuEl.innerHTML = ZSUi.modeMenuHtml(approvalMode);
        modeMenuEl.querySelectorAll(".zs-mode-opt").forEach((b) => b.addEventListener("click", () => chooseMode(b.dataset.id)));
        requestAnimationFrame(positionModeMenu);
      });
      document.addEventListener("click", (e) => {
        if (!modeMenuEl.hidden && !modeMenuEl.contains(e.target) && !modeBtn.contains(e.target)) modeMenuEl.hidden = true;
      }, true);
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes.zsApprovalMode && ZSUi.APPROVAL_MODES.some((m) => m.id === changes.zsApprovalMode.newValue)) {
            approvalMode = changes.zsApprovalMode.newValue;
            renderMode();
          }
        });
      } catch {}
      renderMode();

      // The workspace pill: Auto follows VS Code's active window; or pin one of its open folders, or any folder typed in.
      const wsBtn = root.querySelector("#zs-ws-btn");
      const wsMenuEl = root.querySelector("#zs-ws-menu");
      const renderWorkspace = () => { root.querySelector("#zs-ws-name").textContent = ZSUi.workspaceLabel(pinnedWorkspace); wsBtn.title = pinnedWorkspace || "Auto: follows the active VS Code window"; };
      const positionWsMenu = () => {
        if (wsMenuEl.hidden) return;
        ZSUi.applyMenuPlacement(wsMenuEl, ZSUi.computeMenuPlacement({
          anchor: wsBtn.getBoundingClientRect(), menuWidth: wsMenuEl.offsetWidth, defaultWidth: 300,
          viewport: ZSUi.viewportOf(document, window), align: "right", roomAbove: 240,
        }));
        requestAnimationFrame(positionWsMenu);
      };
      const wsError = (text) => { const el = wsMenuEl.querySelector(".zs-ws-error"); if (el) { el.textContent = text; el.hidden = !text; } };
      async function useWorkspace(path, { typed = false } = {}) {
        // A folder typed in may be anywhere on the machine: ask once, in the page-proof dialog, before the agent may work in it.
        if (typed && !(await confirmPort.ask({
          description: `Let the agent read and change files in this folder?\n${path}`,
          tool: "Workspace", risk: "write",
        }))) return;
        const reply = await bg({ type: "set_workspace", path });
        if (!reply.ok) { wsError(reply.error || "Could not use that folder."); return; }
        pinnedWorkspace = reply.pinned;
        wsMenuEl.hidden = true;
        renderWorkspace();
        // A successfully pinned folder is a usable workspace right away; "Auto" goes back to probing.
        bridgeMonitor.workspaceReady = !!pinnedWorkspace;
        bridgeMonitor.workspaceProbePending = false;
        catalogue.ensure(true);
        notifications.toast(pinnedWorkspace ? `Working in ${ZSUi.workspaceLabel(pinnedWorkspace)}` : "Following the active VS Code window");
      }
      wsBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (menuEl) menuEl.hidden = true;
        targetMenuEl.hidden = true;
        modeMenuEl.hidden = true;
        wsMenuEl.hidden = !wsMenuEl.hidden;
        if (wsMenuEl.hidden) return;
        const listing = await bg({ type: "workspaces" });
        if (!listing.ok) { wsMenuEl.hidden = true; notifications.toast(listing.error || "The bridge is not reachable."); return; }
        pinnedWorkspace = listing.pinned;
        renderWorkspace();
        wsMenuEl.innerHTML = ZSUi.workspaceMenuHtml(listing);
        wsMenuEl.querySelectorAll(".zs-ws-opt").forEach((b) => b.addEventListener("click", () => useWorkspace(b.dataset.path)));
        // Typing here must not trigger the site's own keyboard shortcuts.
        const folderInput = wsMenuEl.querySelector(".zs-ws-input");
        for (const type of ["keydown", "keyup", "keypress", "input"]) folderInput.addEventListener(type, (event) => event.stopPropagation());
        const pickBtn = wsMenuEl.querySelector(".zs-ws-pick");
        pickBtn.addEventListener("click", async () => {
          wsError("");
          pickBtn.disabled = true;
          pickBtn.querySelector(".zs-site-host").textContent = "waiting for the folder window…";
          const picked = await bg({ type: "pick_folder" });
          pickBtn.disabled = false;
          pickBtn.querySelector(".zs-site-host").textContent = "opens your system's folder window";
          if (!picked.ok) { wsError(picked.error || "The folder window could not be opened."); wsMenuEl.querySelector(".zs-ws-form").hidden = false; return; }
          // The user chose it themselves in the system's own window: no second question.
          if (picked.picked) useWorkspace(picked.picked);
        });
        wsMenuEl.querySelector(".zs-ws-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const typedPath = wsMenuEl.querySelector(".zs-ws-input").value.trim();
          if (typedPath) useWorkspace(typedPath, { typed: true });
        });
        requestAnimationFrame(positionWsMenu);
      });
      document.addEventListener("click", (e) => {
        if (!wsMenuEl.hidden && !wsMenuEl.contains(e.target) && !wsBtn.contains(e.target)) wsMenuEl.hidden = true;
      }, true);
      // The pill shows what is pinned right now (the bridge may have been restarted, which forgets it).
      const syncWorkspace = async () => { const listing = await bg({ type: "workspaces" }); if (listing.ok) { pinnedWorkspace = listing.pinned; renderWorkspace(); } };
      syncWorkspace();
      renderWorkspace();
      bar.classList.add(`zs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`zs-site-${P.id}`);

      actionBtn.addEventListener("click", onActionClick);
      stopBtn.addEventListener("click", stopLoop);
      stopFloatEl = root.querySelector("#zs-stop-float");
      stopFloatEl.addEventListener("click", (e) => { e.stopPropagation(); stopBtn.click(); }); // the same Stop, reachable while the bar is hidden
      unstableEl = root.querySelector("#zs-unstable");
      if (unstableEl) {
        // Set the native tooltip via PROPERTY, not the HTML template: the warning
        // text may contain double quotes (e.g. GLM's "No response…"), which would
        // terminate a title="..." attribute early and truncate the tooltip.
        unstableEl.title = P.unstableWarning;
        unstableEl.addEventListener("click", (e) => { e.stopPropagation(); notifications.toast(P.unstableWarning); });
      }
      buildMenu();
      // Both bar controls open the same panel; the heart lands on the Support
      // section (last), the model button opens at the top with Switch AI.
      const toggleMenu = (toSupport) => {
        menuEl.hidden = !menuEl.hidden;
        if (!menuEl.hidden) {
          // Rebuild on every open, not just once at page load: the initial
          // buildMenu() call runs before the bridge status (server list/health)
          // has arrived, so the very first render always shows an empty/stale
          // target selector otherwise - nothing ever refreshed it after.
          buildMenu();
          // On a FRESH open, menuEl has no max-height yet - that's only applied by
          // placeBar()'s positioning pass, which runs on the next rAF tick (it's a
          // separate loop, not synchronous with this click). Without it the panel
          // has no overflow yet, so scrollHeight === clientHeight and setting
          // scrollTop here is a no-op - the "jump to Support" silently failed on
          // the very first open (reported live on Arena). Deferring one frame lets
          // placeBar's already-queued tick clip the box first, so there's real
          // scroll room by the time we set scrollTop.
          requestAnimationFrame(() => {
            if (!menuEl.hidden) menuEl.scrollTop = toSupport ? menuEl.scrollHeight : 0;
          });
        }
      };
      switchBtn.addEventListener("click", (e) => { e.stopPropagation(); if (targetMenuEl) targetMenuEl.hidden = true; toggleMenu(false); });
      openMenuFn = (toSupport) => { if (menuEl.hidden) toggleMenu(toSupport); };
      document.addEventListener("click", (e) => {
        if (menuEl.hidden) return;
        if (!menuEl.contains(e.target) && !switchBtn.contains(e.target))
          menuEl.hidden = true;
      }, true);

      const syncTheme = () => ZSUi.applyTheme(document);
      syncTheme();
      setInterval(syncTheme, 4000); // follow the host page toggling its theme
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind).
    function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start") startSession();
      else if (kind === "calibrate") {
        // A part that stopped matching is redone on its own; a site never calibrated is done from the start.
        const problem = P.health && P.health().problems[0];
        openCalibration(problem && ["composer", "send"].includes(problem.role) ? problem.role : null);
      }
    }

    const getTargetName = (id = selectedTargetId) => serverDirectory.name(id);
    function setTarget(id = selectedTargetId) {
      if (!targetSelect) return;
      const options = serverDirectory.targetOptions(id);
      const optionsKey = options.map((option) => `${option.id}:${option.name}`).join("|");
      if (targetSelect.dataset.optionsKey !== optionsKey) {
        targetSelect.innerHTML = ZSUi.targetOptionsHtml(options);
        targetSelect.dataset.optionsKey = optionsKey;
      }
      targetSelect.value = id;
      targetSelect.disabled = false; // never locked: the user may switch MCP target at any time
      const nameEl = root && root.querySelector("#zs-target-name");
      if (nameEl) nameEl.textContent = (options.find((option) => option.id === id) || { name: id }).name;
      if (targetMenuEl && !targetMenuEl.hidden) renderTargetMenu();
    }

    function renderTargetMenu() {
      if (!targetMenuEl || !targetSelect) return;
      // Skip the rewrite when nothing changed: periodic status updates call
      // setTarget() -> renderTargetMenu() and would otherwise destroy the buttons
      // between mouse-down and mouse-up, so the click never fires.
      const menuKey = selectedTargetId + "|" + [...targetSelect.options].map((o) => `${o.value}:${o.textContent}`).join("|");
      if (targetMenuEl.dataset.menuKey === menuKey && targetMenuEl.childElementCount) return;
      targetMenuEl.dataset.menuKey = menuKey;
      targetMenuEl.innerHTML = ZSUi.targetMenuHtml([...targetSelect.options].map((o) => ({ id: o.value, name: o.textContent })), selectedTargetId);
      targetMenuEl.querySelectorAll(".zs-target-opt").forEach((b) =>
        b.addEventListener("click", () => {
          targetMenuEl.hidden = true;
          if (b.dataset.id === selectedTargetId) return;
          targetSelect.value = b.dataset.id;
          targetSelect.dispatchEvent(new Event("change"));
        }));
    }

    function positionTargetMenu() {
      if (!targetMenuEl || targetMenuEl.hidden || !targetBtn) return;
      ZSUi.applyMenuPlacement(targetMenuEl, ZSUi.computeMenuPlacement({
        anchor: targetBtn.getBoundingClientRect(), menuWidth: targetMenuEl.offsetWidth, defaultWidth: 220,
        viewport: ZSUi.viewportOf(document, window), align: "left", roomAbove: 160,
      }));
    }
    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control. Opens above the bar.
    // ── MCP settings popup (toggle which servers are enabled) ───────────────
    // The popup itself is src/ui/mcp-settings.js; what happens when it closes is page policy.
    function openMcpSettings() {
      const servers = serverDirectory.servers();
      ZSUi.openMcpSettings({
        document,
        options: serverDirectory.allOptions().map((o) => ({ id: o.id, name: o.name, tools: (servers.find((sv) => sv.id === o.id) || {}).tools })),
        isEnabled: isMcpEnabled,
        setEnabled: (id, on) => serverDirectory.setEnabled(id, on),
        // Refresh the dropdown right away so a re-enabled server is selectable without waiting for the popup to close.
        onToggle: () => setTarget(selectedTargetId),
        onClose: () => {
          // If the active target was just disabled, move to the first enabled one and reload so the
          // whole extension restarts against it.
          if (!isMcpEnabled(selectedTargetId)) {
            const next = serverDirectory.firstEnabled();
            if (next) {
              selectedTargetId = next.id;
              const reloadPage = () => { try { location.reload(); } catch {} };
              try { chrome.storage.local.set({ [TARGET_STORAGE_KEY]: selectedTargetId }, reloadPage); } catch { reloadPage(); }
              return;
            }
          }
          setTarget(selectedTargetId);
        },
      });
    }

    // ── Skills settings popup: src/ui/skills-settings.js ────────────────────
    function openSkillsSettings() {
      ZSUi.openSkillsSettings({
        document,
        skills: skillsService,
        maxFileBytes: ZSDomain.SKILL_MAX_BYTES,
        loadOnOpen: selectedTargetId === "vscode",
      });
    }

    // ── Site calibration (docs/CALIBRATION.md): src/ui/calibration-wizard.js, profiles in src/application/profile-store.js ──
    const profileStore = new ZSApp.ProfileStore({
      store: {
        get: (key) => new Promise((resolve) => { try { chrome.storage.local.get(key, (r) => resolve(r && r[key])); } catch { resolve(undefined); } }),
        set: (key, value) => new Promise((resolve) => { try { chrome.storage.local.set({ [key]: value }, resolve); } catch { resolve(); } }),
      },
      problemsOf: ZSCalibration.profileProblems,
    });
    let calibrationWizard = null;
    async function openCalibration(only) {
      if (calibrationWizard) calibrationWizard.cancel(false);
      calibrationWizard = ZSUi.createCalibrationWizard({
        document, hostname: location.hostname, name: P.displayName, current: await profileStore.get(location.hostname),
        calibration: {
          learnProfile: ZSCalibration.learnProfile, updateProfile: ZSCalibration.updateProfile,
          createProvider: (profile) => ZSCalibration.createCalibratedProvider({ document, location, profile }),
        },
        onSave: (profile) => profileStore.save(profile),
        describe: (el) => ZSChat.describeElement(el),
      });
      calibrationWizard.start({ only });
    }
    async function exportCalibration() {
      const text = await profileStore.exportText(location.hostname);
      if (!text) { notifications.toast("This site is not calibrated yet."); return; }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      link.download = `snapgent-${location.hostname}.json`;
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    // What a bug report needs: what the profile finds on this page right now (elements, sizes, counts), never the chat's text.
    async function copyDiagnostics() {
      const chain = (el) => { const out = []; for (let n = el; n && n.nodeType === 1 && out.length < 4; n = n.parentElement) out.push(ZSChat.describeElement(n)); return out.join(" < "); };
      const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
      const lines = [`snapgent diagnostics`, `site: ${location.hostname}${location.pathname}`, `calibrated: ${!P.needsCalibration}`,
        `session: started=${A.started} starting=${A.starting} running=${A.running} target=${selectedTargetId}`];
      if (P.diagnose) {
        const d = P.diagnose();
        lines.push(`profile: ${JSON.stringify(d.profile)}`, `health: ${JSON.stringify(d.health)}`,
          `chatIsEmpty=${d.chatIsEmpty} isFreshChat=${d.isFreshChat} key="${d.key}" turns: ${d.userCount} yours, ${d.assistantCount} AI`);
        for (const [label, el] of [["composer", d.composer], ["card", d.card], ["send", d.send]]) lines.push(`${label}: ${el ? `${rect(el)} ${chain(el)}` : "-"}`);
        for (const role of ["user", "assistant"]) {
          lines.push(`${role} matches (first 8):`);
          for (const m of d[role]) lines.push(`  ${m.shown ? "shown" : "hidden"} ${m.chars} chars ${rect(m.el)} ${chain(m.el)}`);
        }
      }
      try { await navigator.clipboard.writeText(lines.join("\n")); notifications.toast("Diagnostics copied."); }
      catch { notifications.toast("Could not copy to the clipboard."); }
    }
    function importCalibration() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const result = await profileStore.importText(await file.text(), location.hostname);
        notifications.toast(result.ok ? "Calibration imported." : result.error);
      });
      input.click();
    }

    function buildMenu() {
      menuEl.innerHTML = ZSUi.switchMenuHtml(AI_SITES, P.displayName, { calibration: true, corner: barPrefs.corner });
      const open = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} menuEl.hidden = true; };
      menuEl.querySelectorAll("button.zs-site-opt[data-u], .zs-tip-opt[data-u]").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      const gear = menuEl.querySelector("#zs-mcp-settings");
      if (gear) gear.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openMcpSettings(); });
      const starBtn = menuEl.querySelector("#zs-skills-settings");
      if (starBtn) starBtn.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openSkillsSettings(); });
      const calibration = (id, action) => {
        const button = menuEl.querySelector(id);
        if (button) button.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; action(); });
      };
      calibration("#zs-bar-corner", () => setBarPrefs({ corner: barPrefs.corner === "top" ? "bottom" : "top" }));
      calibration("#zs-bar-hide", () => setBarPrefs({ hidden: true }));
      calibration("#zs-cal-start", () => openCalibration(null));
      calibration("#zs-cal-export", exportCalibration);
      calibration("#zs-cal-import", importCalibration);
      calibration("#zs-cal-diag", copyDiagnostics);
      calibration("#zs-cal-remove", async () => { await profileStore.remove(location.hostname); notifications.toast("Calibration removed."); });
    }

    // ── First-time onboarding card (src/ui/setup-card.js) ───────────────────
    let setupSeen = false;
    try {
      chrome.storage.local.get("zsSetupSeen", (r) => {
        if (r && r.zsSetupSeen) setupSeen = true;
      });
    } catch {}
    const setupCard = ZSUi.createSetupCard({
      document,
      githubUrl: GITHUB_URL,
      onDismiss: () => {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
      },
    });

    function refreshSetup(bridgeConnected) {
      const show = ZSUi.shouldShowSetup({
        dismissed: setupSeen, bridgeConnected, hasSession: A.started || A.starting, chatIsEmpty: P.chatIsEmpty(),
      });
      if (show) setupCard.show(); else setupCard.hide();
    }

    // The single source of truth for the bar's content. Decides the status tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting…"
    //  • session active   → "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/workspace warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      if (!bar) return;
      setTarget(selectedTargetId);
      renderMode();
      // The decision (what the bar says, which tone, which action) is a pure function: src/ui/bar-view.js.
      const view = ZSUi.computeBarView({
        staleExtension: A.staleExtension,
        starting: A.starting,
        started: A.started,
        running: A.running,
        parked: A.parked,
        blankChat: !A.started && !A.starting && !A.staleExtension && (P.isFreshChat() || P.chatIsEmpty()),
        bridge: A.bridge,
        bridgeOk: bridgeMonitor.bridgeOk,
        target: { id: selectedTargetId, name: getTargetName() },
        activeToolCount: activeTools().length,
        workspaceReady: bridgeMonitor.workspaceReady,
        workspaceProbePending: bridgeMonitor.workspaceProbePending,
        modeWarning: !A.started && !A.starting && P.modeWarning ? P.modeWarning() : null,
        needsCalibration: !!P.needsCalibration,
      });
      const toneClass = view.tone, msg = view.message, label = view.label, kind = view.kind;
      const disabled = view.disabled, warn = view.warn;
      const indicator = view.spinner ? `<span class="zs-spin"></span>` : "";
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Keep target and provider selectors available before startup so the user
      // can choose both sides of the connection before launching the agent.
      const showExtras = true;
      const sig = [toneClass, indicator, msg, label, kind, disabled, warn, busy, showExtras].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. zs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      stateEl.innerHTML = indicator + `<span class="zs-state-txt">${msg}</span>`;
      stateEl.classList.toggle("zs-state-warn", warn);
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.disabled = disabled;
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector + tips/support: only once a session is live. Discord stays
      // visible in every state (it's the help link).
      if (switchBtn) switchBtn.style.display = showExtras ? "" : "none";
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { renderBar(); }
    function setStarting() { renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      if (!bar) return;
      const health = bridgeMonitor.update(s, selectedTargetId);
      setTarget(selectedTargetId);
      if (health.lost) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // The page outlived its extension build (reload / Chrome auto-update /
    // disable+enable). Distinct from bridgeAlert on purpose: opposite cause,
    // opposite fix, and this one NEVER self-heals, so the banner has no Close
    // button and offers the reload directly rather than telling the user to go
    // restart a bridge that was never down.
    function staleExtensionAlert() {
      // Latch it BEFORE painting, so the bar drops its frozen "Agent active · N tools" in the same pass
      // and never contradicts the banner.
      A.staleExtension = true;
      renderBar();
      notifications.showStaleExtension();
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) { notifications.setBridgeLost(on); }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled "⏳ Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = "⏳ Stopping…";
      renderBar();
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable it.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        notifications.toast(`Click “▶︎ Start” to begin.`);
      }
      if (!actionBtn) return;
      actionBtn.classList.add("zs-flash");
      setTimeout(() => actionBtn.classList.remove("zs-flash"), 1200);
    }

    // Theme auto-detection (light / dark) lives in ui/page-theme.js; see ZSUi.applyTheme.

    // Where the bar goes on the page (inline in the composer, anchored above it, floating, or hidden): src/ui/bar-placer.js.
    const barPlacer = ZSUi.createBarPlacer({
      document, provider: P, prefs: () => barPrefs, parts: () => ({ bar, root, menuEl, unstableEl, toggleEl, stopEl: stopBtn, stopFloatEl }), positionMenu,
    });
    function placeBar() {
      barRaf = requestAnimationFrame(placeBar); // scheduled first, so a throw below cannot stop the loop
      barPlacer.place();
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // The cover itself (kept on the live editor frame by frame): src/ui/input-cover.js
    const inputCoverView = ZSUi.createInputCover({ document, provider: P });
    const inputCover = (on) => inputCoverView.set(on);
    const inputCoverLabel = (text) => inputCoverView.setLabel(text);

    build();
    return { setStatus, setTarget, getTargetName, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, inputCoverLabel, toast: (m) => notifications.toast(m), banner: (kind, title, msg) => notifications.banner(kind, title, msg), showImages: (images, name) => notifications.showImages(images, name), nudgeStart, updateStartGate, refreshSetup, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".zs-chip .zs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // snapgentV3's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#zs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

  let _prevHardGen = null, _prevSoftGen = null;
  setInterval(() => {
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #zs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          haltedTurns.forget(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous command chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".zs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live snapgentV3 session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a ZS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ? P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    ui.showStop(A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating()));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ? P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && ZSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = ZSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, needsApproval: msg.needsApproval, tools: msg.tools, servers: msg.servers });
    }
    if (msg && msg.type === "zs-open-menu") {
      ui.openMenu(false); // from the popup's Settings button — opens at the top (Switch AI)
    }
  });

  // Status poll. An orphaned content script (see bg / isContextInvalidated) gets
  // a failure object back whose `connected` is undefined, which setStatus would
  // read as "the bridge just dropped" and answer with the red "run start.bat"
  // banner - sending the user to fix a bridge that is perfectly healthy, with
  // the one thing that WOULD fix it (reload the page) never mentioned. Catch it
  // before setStatus, say the right thing, and stop polling: the context can
  // never come back, so every later tick would just repeat the same failure.
  let statusTimer = 0;
  function onStatus(s) {
    if (!s) return;
    if (s.kind === "stale-extension") {
      clearInterval(statusTimer);
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: s.error });
      return;
    }
    ui.setStatus(s);
  }
  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  sysTally.hydrate();
  bg({ type: "status" }).then(onStatus);
  statusTimer = setInterval(() => bg({ type: "status" }).then(onStatus), 10000);

  // Session state is derived from the ACTUAL chat and remembered per conversation (src/application/session-tracker.js).
  const { SessionTracker, textShowsSession } = ZSApp;
  const sessionTracker = new SessionTracker({
    store: {
      get: (key) => new Promise((resolve) => { try { chrome.storage.local.get(key, (r) => resolve(r && r[key])); } catch { resolve(undefined); } }),
      set: (key, value) => { try { chrome.storage.local.set({ [key]: value }); } catch {} },
    },
  });
  sessionTracker.ready.then(() => syncSessionState());
  const markerInDom = () => P.allItems().some((item) => textShowsSession(item.textContent || "", ZS.SYS_MARKER));

  function syncSessionState() {
    const decide = () => sessionTracker.decide({
      starting: A.starting, startingKey: A.startingKey, running: A.running, loopKey: A.loopKey, injecting: A.injecting,
      started: A.started, key: P.conversationKey(), chatEmpty: P.chatIsEmpty(), markerInDom,
    });
    const loopKeyBefore = A.loopKey;
    let decision = decide();
    if (decision.startingKey !== undefined) A.startingKey = decision.startingKey;
    if (decision.loopKey !== undefined) A.loopKey = decision.loopKey;
    if (decision.abandonStart) {
      // The in-flight startSession bails at its next checkpoint (startGen). Its own finally is gated on alive(), which this
      // just invalidated, so it will NEVER lift the "Agent is working…" cover: lift it here, or it sticks on the fresh chat.
      A.startGen++;
      A.starting = false;
      P.setInputLock(false);
      ui.setStarting(false);
      ui.inputCover(false);
      decision = decide(); // no longer bootstrapping: the new chat's own state is computed in the same pass
    }
    if (decision.abandonLoop) {
      diag("loop.abandonedNewChat", { from: loopKeyBefore, to: P.conversationKey() });
      A.stop = true; // the loop breaks at its next checkpoint; its finally resets A.running / cover / lock
    }
    if (decision.started !== undefined) {
      A.started = decision.started;
      ui.setStarted(decision.started);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    if (!DECORATE) return;
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("zs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("zs-hidden")) continue;
      const txt = P.classifyText(item, ".zs-chip");
      if (txt.includes(ZS.SYS_MARKER) ||
          (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt))) {
        item.classList.add("zs-hidden");
      }
    }
  }
  const mo = new MutationObserver(() => {
    preHideWholeItems();
    scheduleSweep();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // Belt-and-braces: a low-frequency sweep regardless of tab visibility or
  // mutation timing, so camouflage always converges.
  setInterval(scheduleSweep, 2500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });
  // The provider swapped (a site profile was stored or removed): redraw the bar and re-read the page now.
  document.addEventListener("zs-provider-changed", () => scheduleSweep());

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    // Every refusal to treat a typed message as an agent turn is logged: it is silent otherwise.
    isBlocked: () => {
      const blocked = A.injecting || A.running || A.starting;
      if (blocked) diag("send.blocked", { injecting: A.injecting, running: A.running, starting: A.starting });
      return blocked;
    },
    isStarted: () => {
      if (!A.started) diag("send.notStarted", { empty: P.chatIsEmpty() });
      return A.started;
    },
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      diag("send.user", { base });
      promptResender.bump("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => {
        if (!A.running && !A.userStopped) agentLoop(base);
        else diag("loop.notStarted", { running: A.running, userStopped: A.userStopped });
      }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; haltedTurns.forget(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
  const RESUME_FRESH_MS = 180000;
  // Why the watchdog did NOT resume, logged only when the reason changes (it runs every second).
  let lastResumeSkip = "";
  const skip = (reason) => { if (reason !== lastResumeSkip) { lastResumeSkip = reason; diag("resume.skip", { reason }); } };
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return skip(`state started=${A.started} running=${A.running} starting=${A.starting} injecting=${A.injecting}`);
    if (document.hidden) return skip("hidden");                         // AI tab not foreground → don't parse/exec off-screen (agentLoop gates too)
    if (A.userStopped) return skip("userStopped");                          // user halted → never relaunch
    if (P.isGenerating()) return skip("generating");
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return skip("stale"); // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return skip(item ? "zloop" : "noItem");
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "command leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return skip("bootBaseline");
    if (P.turnHalted(item)) return skip("halted");                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return skip("oldTurn");
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return skip("resultBelow");
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return skip("noSignature");
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (executedTurns.has(item, txt)) return skip("alreadyExecuted");
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return skip("unparseable");
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return skip("resumedOnce");
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    executedTurns.remember(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (PromptResender.attach) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
  const SYS_FALLBACK_IDLE_MS = 20000;
  setInterval(async () => {
    if (!promptResender.due()) return;
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden || A.userStopped) return;
    if (P.isGenerating()) return;
    // The user is composing - their draft owns the editor, leave it alone.
    try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
    // Give the cheap path a fair chance first: only step in once the turn has
    // been settled and quiet for a while with no tool result to ride on.
    if (Date.now() - A.lastGenAt < SYS_FALLBACK_IDLE_MS) return;
    promptResender.claim("ownTurn");
    try {
      const base = await submitAndGetBase(systemPrompt());
      await waitForResponse(base);
    } catch (e) {
      diag("sys.resendFailed", { err: String(e && e.message || e) });
    }
  }, 5000);

  log(`snapgentV3 content script ready (provider: ${P.id})`);
})();
