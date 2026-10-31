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

  // ── MCP enable/disable toggles ──────────────────────────────────────────
  // Persisted map { serverId: boolean }. A server that was never toggled counts
  // as enabled. Disabled servers are hidden from the target dropdown AND are
  // filtered out of everything the AI reads (tool lists, list_mcp_servers,
  // list_commands) so their tool schemas never cost tokens.
  const MCP_ENABLED_KEY = "zsMcpEnabled";
  let mcpEnabled = {};
  try {
    chrome.storage.local.get(MCP_ENABLED_KEY, (result) => {
      const saved = result && result[MCP_ENABLED_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        mcpEnabled = saved;
        if (typeof ui !== "undefined" && ui.setTarget) ui.setTarget(selectedTargetId);
      }
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load MCP toggles:", error);
  }
  function isMcpEnabled(id) {
    return mcpEnabled[id] !== false;
  }
  function setMcpEnabled(id, on) {
    mcpEnabled = { ...mcpEnabled, [id]: !!on };
    try { chrome.storage.local.set({ [MCP_ENABLED_KEY]: mcpEnabled }); } catch {}
  }

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
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
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
  const toolRunner = new ToolRunner({
    bridge: bridgePort, catalogue, session: sessionPort, visibility: visibilityPort, sink: sinkPort, confirm: confirmPort,
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
      if (item) { item.dataset.zStopped = "1"; rememberHalted(item); }
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

  const loop = new AgentLoop({
    chat: loopChat,
    view: loopView,
    lifecycle: loopLifecycle,
    visibility: visibilityPort,
    runner: toolRunner,
    tools: loopTools,
    memory: { executed: (item) => rememberExecuted(item) },
    // A result becomes a turn, so it counts toward the system-prompt re-statement budget and may carry it.
    outbox: { prepare: (text) => { promptResender.bump("results"); return promptResender.attach(text); } },
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
  const agentLoop = (base) => (A.running ? undefined : loop.run(base));

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
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
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
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
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
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
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
      rememberHalted(A.toolItem);
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
      customPrompt: ui.getCustomPrompt(),
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
    charBudget: () => P.sendCharBudget || Infinity,
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
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
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

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { cls, whole } = opts;
      // Drawing lives in ui/chip-view.js (paintChip). It rebuilds the inner markup only when the
      // signature changes, so the streaming spinner keeps animating. Re-anchoring + masking below
      // still run on every pass.
      const chip = ZSUi.paintChip(document, item.querySelector(".zs-chip"), opts);

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ? P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ? chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.zs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__zsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__zsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".zs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .zs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ? "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(ZS.RESEND_MARKER)) {
        if (item.dataset.zs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ? `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.zs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : hasImg ? "img" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: hasImg ? "screen" : m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
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
      // asked for. Same principle as domHasZsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = ZSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: ZSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __zsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            ZSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          ZSParse.isInjectedFeedback(P.classifyText(next, ".zs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "command leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ? "err" : (orphanPending ? "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ? "stopped" : (orphanPending ? "not run" : "");
        // A DSML turn is the model calling a tool in its OWN markup, which can
        // never be executed - it always resolves to the "dsml" parse_error. So
        // once it has FINISHED streaming, "waiting to run" (spinner) and "not
        // run" (grey) are both wrong: it is not pending, it is already decided.
        // Left alone it inherited pendingExec and span for the whole
        // RESUME_FRESH_MS window before settling grey (reported live 2026-08-22).
        // Gated on !live on purpose: while the model is still WRITING the block
        // it must behave like any other command and show the spinner, or a slow
        // generation gives the user no feedback at all that anything is happening
        // - the chip paints "run" as it streams, then repaints red here the
        // moment generation ends. When our error result lands below, the
        // error-aware settle just below is skipped (phase is no longer "done") so
        // the more precise "bad format" wording survives.
        if (!stopped && !live && phase !== "err" && ZSParse.DSML_RE.test(txt)) {
          phase = "err"; detail = "wrong format";
        }
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".zs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - e.g. a tool that echoes JSON), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (ZSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: ZSParse.toolNameFromText(txt) });
          }
        }
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
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
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

    sweep() {
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
    let root, bar, stateEl, actionBtn, stopBtn, targetSelect, switchBtn, menuEl, unstableEl, notifications;
    let targetBtn, targetMenuEl;
    let cover, coverRaf, barRaf;
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    let bridgeOk = false, workspaceReady = false, workspaceProbePending = false, workspaceProbeAt = 0;
    let wasConnected = false;

    // Placement maths lives in src/ui/menu-position.js; these only measure and apply.
    function positionMenu(anchor) {
      if (!menuEl || menuEl.hidden) return;
      ZSUi.applyMenuPlacement(menuEl, ZSUi.computeMenuPlacement({
        anchor, menuWidth: menuEl.offsetWidth, defaultWidth: 274, viewport: ZSUi.viewportOf(document, window), align: "right", roomAbove: 180,
      }));
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
          <div class="zs-target-wrap" title="Choose which MCP server receives commands">
            <select id="zs-target" aria-label="MCP target" hidden tabindex="-1">
              <option value="vscode">VS Code</option>
            </select>
            <button id="zs-target-btn" type="button" aria-haspopup="listbox" aria-label="Choose MCP target"><span id="zs-target-name"></span></button>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <button id="zs-switch" aria-label="Switch AI and options" title="Switch AI and options"><span id="zs-switch-name"></span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>
        <div id="zs-menu" hidden></div>
        <div id="zs-target-menu" hidden></div>
        ${P.unstableWarning ? `<button id="zs-unstable" aria-label="Provider may be unstable" hidden>⚠ unstable</button>` : ""}
      `;
      document.documentElement.appendChild(root);
      bar = root.querySelector("#zs-bar");
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
      bar.classList.add(`zs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`zs-site-${P.id}`);

      actionBtn.addEventListener("click", onActionClick);
      stopBtn.addEventListener("click", stopLoop);
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
      setInterval(syncTheme, 2000); // follow the host page toggling its theme
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind).
    function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start") startSession();
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("zsCustomPrompt", (r) => {
        if (r && typeof r.zsCustomPrompt === "string") {
          customPrompt = r.zsCustomPrompt;
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // Cached names for user-added MCP servers. The bridge remains the source of
    // truth; this cache keeps addon names available in the target selector.
    let customMcpServers = [];
    try {
      chrome.storage.local.get("zsCustomMcpServers", (r) => {
        if (r && Array.isArray(r.zsCustomMcpServers)) {
          customMcpServers = r.zsCustomMcpServers;
        }
      });
    } catch {}
    function saveCustomMcpServers() {
      try { chrome.storage.local.set({ zsCustomMcpServers: customMcpServers }); } catch {}
    }
    // The bridge (config.json + live health) is the SOURCE OF TRUTH for which
    // addon servers actually exist. Self-heal the local display-name cache when
    // a configured server isn't already known.
    function mergedMcpServers() {
      const live = ((A.bridge && A.bridge.servers) || []).filter((sv) => sv.id !== "vscode");
      const byId = new Map(customMcpServers.map((s) => [s.id, s]));
      const merged = live.map((sv) => {
        const cached = byId.get(sv.id);
        return {
          id: sv.id, name: (cached && cached.name) || sv.id, command: cached && cached.command,
          alive: sv.alive, tools: sv.tools,
        };
      });
      // Self-heal: cache didn't know about a server the bridge actually has.
      let healed = false;
      for (const sv of live) {
        if (!byId.has(sv.id)) { customMcpServers.push({ id: sv.id, name: sv.id }); healed = true; }
      }
      if (healed) saveCustomMcpServers();
      // A server we just added/removed but the bridge hasn't reported back on
      // yet (mid-restart) - still show it, health unknown, so it doesn't blink
      // out of the list during the few seconds the bridge is restarting.
      for (const s of customMcpServers) {
        if (!merged.some((m) => m.id === s.id)) merged.push({ ...s, alive: undefined, tools: undefined });
      }
      return merged;
    }

    function getTargetName(id = selectedTargetId) {
      if (id === "vscode") return "VS Code";
      const server = mergedMcpServers().find((item) => item.id === id);
      return server ? server.name : id;
    }
    function setTarget(id = selectedTargetId) {
      if (!targetSelect) return;
      const options = [
        { id: "vscode", name: "VS Code" },
        ...mergedMcpServers()
          .filter((server) => server.id !== "vscode")
          .map((server) => ({ id: server.id, name: getTargetName(server.id) })),
      ].filter((option) => isMcpEnabled(option.id));
      if (!options.some((option) => option.id === id)) {
        options.push({ id, name: id });
      }
      const optionsKey = options.map((option) => `${option.id}:${option.name}`).join("|");
      if (targetSelect.dataset.optionsKey !== optionsKey) {
          targetSelect.innerHTML = options
            .map((option) => `<option value="${option.id.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${option.name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))}</option>`)
            .join("");
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
      const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      // Skip the rewrite when nothing changed: periodic status updates call
      // setTarget() -> renderTargetMenu() and would otherwise destroy the buttons
      // between mouse-down and mouse-up, so the click never fires.
      const menuKey = selectedTargetId + "|" + [...targetSelect.options].map((o) => `${o.value}:${o.textContent}`).join("|");
      if (targetMenuEl.dataset.menuKey === menuKey && targetMenuEl.childElementCount) return;
      targetMenuEl.dataset.menuKey = menuKey;
      const rows = [...targetSelect.options].map((o) => {
        const cur = o.value === selectedTargetId;
        return `<button type="button" class="zs-site-opt zs-target-opt${cur ? " zs-target-cur" : ""}" data-id="${esc(o.value)}"><span class="zs-site-name"><span>${esc(o.textContent)}</span></span>${cur ? `<span class="zs-site-badge">active</span>` : ""}</button>`;
      }).join("");
      targetMenuEl.innerHTML =
        `<section class="zs-menu-sec"><div class="zs-sec-label"><span>MCP target</span></div>${rows}</section>`;
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
    function allMcpOptions() {
      const base = [{ id: "vscode", name: "VS Code" }];
      const extra = mergedMcpServers()
        .filter((s) => !base.some((b) => b.id === s.id))
        .map((s) => ({ id: s.id, name: getTargetName(s.id) }));
      return [...base, ...extra];
    }

    // The popup itself is src/ui/mcp-settings.js; what happens when it closes is page policy.
    function openMcpSettings() {
      const servers = mergedMcpServers();
      ZSUi.openMcpSettings({
        document,
        options: allMcpOptions().map((o) => ({ id: o.id, name: o.name, tools: (servers.find((sv) => sv.id === o.id) || {}).tools })),
        isEnabled: isMcpEnabled,
        setEnabled: setMcpEnabled,
        // Refresh the dropdown right away so a re-enabled server is selectable without waiting for the popup to close.
        onToggle: () => setTarget(selectedTargetId),
        onClose: () => {
          // If the active target was just disabled, move to the first enabled one and reload so the
          // whole extension restarts against it.
          if (!isMcpEnabled(selectedTargetId)) {
            const next = allMcpOptions().find((o) => isMcpEnabled(o.id));
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

    function buildMenu() {
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      let sites = "";
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const label = `<span class="zs-site-name"><span>${s.name}</span><span class="zs-site-host">${hostOf(s.url)}</span></span>`;
        sites += current
          ? `<div class="zs-site-opt zs-site-here">${label}<span class="zs-site-badge">active</span></div>`
          : `<button class="zs-site-opt" data-u="${s.url}">${label}<span class="zs-site-go">&rarr;</span></button>`;
      }
      menuEl.innerHTML =
        `<div class="zs-menu-head"><span class="zs-menu-logo">snapgentV3</span></div>
         <section class="zs-menu-sec">
           <div class="zs-sec-label zs-sec-label-row"><span>Switch AI</span><span><button id="zs-skills-settings" class="zs-gear" title="Skills" aria-label="Skills">&#9733;</button><button id="zs-mcp-settings" class="zs-gear" title="MCP settings" aria-label="MCP settings">&#9881;</button></span></div>
           <div class="zs-site-grid">${sites}</div>
         </section>`;
      const open = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} menuEl.hidden = true; };
      menuEl.querySelectorAll("button.zs-site-opt, .zs-tip-opt").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      const gear = menuEl.querySelector("#zs-mcp-settings");
      if (gear) gear.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openMcpSettings(); });
      const starBtn = menuEl.querySelector("#zs-skills-settings");
      if (starBtn) starBtn.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openSkillsSettings(); });
    }

    // ── First-time onboarding card (bridge missing) ─────────────────────────
    let setupCard = null, setupSeen = false, setupRaf = null;
    try {
      chrome.storage.local.get("zsSetupSeen", (r) => {
        if (r && r.zsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "zs-setup";
      setupCard.hidden = true;
      setupCard.innerHTML =
        `<div id="zs-setup-head"><span id="zs-setup-logo">snapgentV3</span><span id="zs-setup-tag">Setup</span></div>` +
        `<div id="zs-setup-sub">3 quick steps.</div>` +
        `<ol id="zs-setup-steps">` +
          `<li>Open <b>Settings</b></li>` +
          `<li>Run <code>start.bat</code></li>` +
          `<li>Press <b>Start</b></li>` +
        `</ol>` +
        `<div class="zs-setup-copy-row">` +
          `<input type="text" id="zs-setup-link" readonly value="${GITHUB_URL}">` +
          `<button id="zs-setup-copy">Copy</button>` +
        `</div>` +
        `<button id="zs-setup-dismiss">OK</button>`;
      document.documentElement.appendChild(setupCard);

      setupCard.querySelector("#zs-setup-copy").addEventListener("click", () => {
        try { navigator.clipboard.writeText(GITHUB_URL); } catch {
          const inp = setupCard.querySelector("#zs-setup-link");
          inp.select(); try { document.execCommand("copy"); } catch {}
        }
        const btn = setupCard.querySelector("#zs-setup-copy");
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      });

      setupCard.querySelector("#zs-setup-dismiss").addEventListener("click", () => {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
        hideSetup();
      });
    }

    // The onboarding card is pinned to the top-right corner (via CSS), out of the
    // way of the composer; nothing to reposition per frame.
    function placeSetup() {}

    function showSetup() {
      if (!setupCard) buildSetup();
      if (setupCard.hidden) {
        setupCard.hidden = false;
        cancelAnimationFrame(setupRaf);
        placeSetup();
      }
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
      cancelAnimationFrame(setupRaf);
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      // Bridge is down, but if the user is just READING an existing
      // conversation with no snapgentV3 session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
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
      // The decision (what the bar says, which tone, which action) is a pure function: src/ui/bar-view.js.
      const view = ZSUi.computeBarView({
        staleExtension: A.staleExtension,
        starting: A.starting,
        started: A.started,
        running: A.running,
        parked: A.parked,
        blankChat: !A.started && !A.starting && !A.staleExtension && (P.isFreshChat() || P.chatIsEmpty()),
        bridge: A.bridge,
        bridgeOk,
        target: { id: selectedTargetId, name: getTargetName() },
        activeToolCount: activeTools().length,
        workspaceReady,
        workspaceProbePending,
        modeWarning: !A.started && !A.starting && P.modeWarning ? P.modeWarning() : null,
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
      const servers = s.servers || [];
      const selected = servers.find((item) => item.id === selectedTargetId);
      const serverConnected = !!s.connected && !!selected && !!selected.alive;
      const ready = serverConnected &&
        ((selected.tools || 0) > 0 || activeTools().length > 0);
      bridgeOk = ready;
      setTarget(selectedTargetId);
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
      }
      if (selectedTargetId === "vscode" && serverConnected && !workspaceProbePending &&
          Date.now() - workspaceProbeAt >= 5000) {
        workspaceProbeAt = Date.now();
        workspaceProbePending = true;
        catalogue.ensure(false).then(() => {
          const workspaceTool = activeTools().find((tool) => bareToolName(tool.name) === "list_dir");
          bridgeOk = serverConnected &&
            ((selected.tools || 0) > 0 || activeTools().length > 0);
          if (!workspaceTool) {
            workspaceReady = false;
            return;
          }
          return bg({
            type: "call_tool",
            name: workspaceTool.name,
            arguments: { path: "." },
            timeout: 5000,
          }).then((result) => {
            workspaceReady = !!(result && result.ok);
          });
        }).catch((error) => {
          workspaceReady = false;
          console.warn("[snapgentV3] Could not verify VS Code workspace:", error);
        }).finally(() => {
          workspaceProbePending = false;
          renderBar();
        });
      } else if (selectedTargetId === "vscode" && !serverConnected) {
        workspaceReady = false;
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

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      const m = P.barMount();
      return (m && m.parent && m.parent.isConnected) ? m : null;
    }

    // Floating fallback geometry (used only when no inline mount is available).
    const BAR_MAX_W = 560, BAR_GAP = 8;

    // Anchored mode bookkeeping: the composer element whose top padding we are
    // borrowing to seat the bar (see the anchored branch below). Cleared when we
    // leave anchored mode so the site's composer returns to its normal layout.
    let anchorPadEl = null;
    function clearAnchorPad() {
      if (anchorPadEl) { try { anchorPadEl.style.paddingTop = ""; } catch {} anchorPadEl = null; }
    }

    // Position the floating "⚠ unstable" pill just above the bar's left edge.
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      u.style.left = Math.round(br.left) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    function placeBar() {
      barRaf = requestAnimationFrame(placeBar);
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #zs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // rAF loop is resilient (its next frame is scheduled before any body code),
      // so the panel reappears on the very next frame.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every frame - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next frame once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        (P.overlayBlocking && P.overlayBlocking())
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (menuEl) menuEl.hidden = true;
        return;
      }

      // Preferred: in-flow mount inside the composer (no overlap, full width).
      const mount = computeBarMount();
      if (mount) {
        clearAnchorPad();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("zs-bar-inline")) {
          bar.classList.add("zs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        // Transparent (blends in) when mounted INSIDE the input box; surface card
        // when mounted ABOVE it. The provider's barMount() signals which via .inside.
        bar.classList.toggle("zs-bar-inside", !!mount.inside);
        bar.style.display = "flex";
        if (menuEl && !menuEl.hidden) {
          const br = bar.getBoundingClientRect();
          positionMenu(br);
        }
        return;
      }

      // Anchored mode: the provider wants the integrated, in-composer LOOK but
      // its composer is a framework-reconciled subtree we must NOT insert our
      // node into (e.g. Kimi's Vue tree - inserting #zs-bar there makes Vue's
      // next diff reuse the bar node as a host and nest the editor inside it).
      // So we keep the bar in our own #zs-root, position it (position:fixed) to
      // hug the composer's top edge at full width, and RESERVE that strip with
      // padding-top on the composer so it reads as in-flow without ever becoming
      // a child of the framework's DOM. barAnchor() returns the element to hug.
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside");
        bar.classList.add("zs-bar-anchored");
        if (root && bar.parentElement !== root) root.appendChild(bar);
        const r = anchorEl.getBoundingClientRect();
        if (!r.width) { bar.style.display = "none"; clearAnchorPad(); if (menuEl) menuEl.hidden = true; return; }
        bar.style.display = "flex";
        const bh = bar.offsetHeight || 34;
        if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
        anchorPadEl = anchorEl;
        anchorEl.style.paddingTop = (bh + 6) + "px"; // reserve the strip the bar sits in (+gap)
        bar.style.left = Math.round(r.left) + "px";
        bar.style.top = Math.round(r.top) + "px";
        bar.style.width = Math.round(r.width) + "px";
        if (menuEl && !menuEl.hidden) {
          bar.classList.remove("zs-bar-inline"); // ensure fixed geometry for menu math
          positionMenu({ left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + (bar.offsetHeight || 34) });
        }
        return;
      }
      bar.classList.remove("zs-bar-anchored");
      clearAnchorPad();

      // Fallback: float just above the editor (fixed positioning), for sites
      // where no clean inline mount could be resolved.
      if (bar.classList.contains("zs-bar-inline")) {
        bar.classList.remove("zs-bar-inline");
        if (root && bar.parentElement !== root) root.appendChild(bar);
      }
      const f = (P.getEditor && P.getEditor()) || (P.composerFrame && P.composerFrame());
      if (!f) { bar.style.display = "none"; if (menuEl) menuEl.hidden = true; return; }
      bar.style.display = "flex";
      const r = f.getBoundingClientRect();
      if (!r.width) { bar.style.display = "none"; return; }
      const w = Math.min(r.width, BAR_MAX_W);
      const left = Math.round(r.left + (r.width - w) / 2);
      const bh = bar.offsetHeight || 40;
      const top = Math.max(4, Math.round(r.top - bh - BAR_GAP));
      bar.style.width = w + "px";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // Keep the open "more" menu anchored to the bar, opening upward.
      if (menuEl && !menuEl.hidden) {
        const br = bar.getBoundingClientRect();
        positionMenu(br);
      }
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // The cover's fill colour is computed by ui/cover-color.js (ZSUi.opaqueBg).

    function inputCover(on) {
      const ed = P.getEditor();
      if (!on) {
        if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
        if (ed) ed.classList.remove("zs-typing");
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      ed.classList.add("zs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "zs-input-cover";
        cover.innerHTML = `<span>Agent is working…</span>`;
        document.documentElement.appendChild(cover);
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        const e = P.getEditor();
        if (!e) { coverRaf = requestAnimationFrame(place); return; }
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add every frame keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("zs-typing")) e.classList.add("zs-typing");
        // The cover is SIZED to coverTarget() when a provider supplies one, else
        // to the editor node itself. Some composers (Meta AI) make the editable a
        // tiny line inside a much larger rounded card - covering only the editor
        // left the rest of the card exposed and CLICKABLE (a careful click focused
        // the editor and let the user type behind the cover). Meta returns its
        // whole composer card so the cover blankets the entire input band and its
        // pointer-events:auto blocks every click. The typing mask above still lives
        // on the real editor node `e`.
        const covNode = (P.coverTarget && P.coverTarget()) || e;
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          (P.overlayBlocking && P.overlayBlocking()) ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          coverRaf = requestAnimationFrame(place);
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .zs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        // The SAME clipping applies horizontally, and for the same reason: a
        // composer whose editor is a flex item grows to its content width when a
        // long unbroken line is injected, while an ancestor with overflow-x:hidden
        // keeps the PAGE looking right. Seen on ChatGPT at Start, where the editor
        // is filled with the (large) system prompt: the inner
        // .prosemirror-parent widened past its `-my-2.5 flex overflow-x-hidden`
        // wrapper, so the cover - position:fixed and sized to the raw rect - stuck
        // out to the RIGHT of the composer card. Clip on each axis independently:
        // the ancestor that clips X is not always the one that clips Y.
        let clipY = false, clipX = false;
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
          const st = getComputedStyle(a);
          const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
          const ar = a.getBoundingClientRect();
          if (!clipY && clips(st.overflowY)) {
            clipY = true;
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
          }
          if (!clipX && clips(st.overflowX)) {
            clipX = true;
            const left = Math.max(r.left, ar.left);
            const right = Math.min(r.right, ar.right);
            if (right > left) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never paint outside the composer card. The cover is position:fixed and
        // re-placed every rAF from a freshly measured rect, which is correct while
        // the page is still - but a site that ANIMATES its composer updates layout
        // AFTER our callback, so for the whole animation the cover trails one frame
        // behind. Seen on ChatGPT at Start: injecting the system prompt grows the
        // composer 58px -> 156px, the page gains a scrollbar, the content column
        // narrows and the composer slides 29px left - while the cover kept the
        // previous coordinates and hung 28px past the card's right edge. It only
        // showed on the FIRST send, because afterwards the composer is already
        // docked at the bottom and stops moving. Clamping to the composer frame
        // makes a stale rect impossible to see: worst case the cover is briefly a
        // few px small, which reads as nothing.
        const frame = P.composerFrame && P.composerFrame();
        if (frame) {
          const fr = frame.getBoundingClientRect();
          // Only clamp to a frame that really wraps the cover target, so a provider
          // whose frame is narrower than its editor can never shrink the cover.
          const cx = r.left + r.width / 2;
          if (fr.width > 0 && fr.left <= cx && fr.right >= cx) {
            const left = Math.max(r.left, fr.left);
            const right = Math.min(r.right, fr.right);
            if (right - left > 40) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Optionally overshoot the editor box by PAD px on every side. Some
        // composers (Gemini's Quill) keep typed text near rounded corners, so a
        // cover sized EXACTLY to the editor leaves slivers of text peeking; those
        // providers set coverPad to bleed past the edges. A native <textarea>
        // (DeepSeek) needs none - overshooting there just makes the cover overflow
        // the composer, so it defaults to 0.
        const PAD = P.coverPad || 0;
        // Optional vertical nudge: some composers (Gemini's Quill) report an
        // editor rect that sits a few px below the visual input box centre, so
        // the centred "Agent is working…" text looks low. A provider can shift it.
        const OFFY = P.coverOffsetY || 0;
        // Height is at least MIN_H so the label is readable even over a
        // single-line composer. CENTER the cover on the editor's vertical middle
        // rather than anchoring its TOP to the editor top: a short (e.g. 20px)
        // textarea bumped to 36px would otherwise grow only DOWNWARD, leaving the
        // "Agent is working…" label sitting high in the composer's input band
        // (seen on Cloudflare's 1-line textarea). For a composer already taller
        // than MIN_H the maths reduces to the old `r.top - PAD`, so DeepSeek/Gemini
        // are unchanged.
        // Hard ceiling: even though .zs-typing caps the editor's visual height
        // (see overlay.css), belt-and-suspenders clamp the cover so a composer
        // whose growing element escapes that CSS cap on some provider can never
        // turn the "Agent is working…" cover into a full-page white slab.
        const MAXH = P.coverMaxH || 200;
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = (r.left - PAD) + "px";
        cover.style.top = (centerY - h / 2) + "px";
        cover.style.width = (r.width + PAD * 2) + "px";
        cover.style.height = h + "px";
        // Composite the surface BEHIND the cover target so the fill matches what
        // the user sees (a translucent composer card blends over the page).
        cover.style.background = ZSUi.opaqueBg(document, covNode);
        // When the cover blankets a whole composer card (coverTarget), match its
        // corner radius so the cover's square corners don't poke past the card's
        // rounded ones. Editor-sized covers keep the CSS default.
        if (P.coverTarget) cover.style.borderRadius = getComputedStyle(covNode).borderRadius;
        coverRaf = requestAnimationFrame(place);
      };
      place();
    }

    build();
    return { setStatus, setTarget, getTargetName, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, toast: (m) => notifications.toast(m), banner: (kind, title, msg) => notifications.banner(kind, title, msg), showImages: (images, name) => notifications.showImages(images, name), nudgeStart, updateStartGate, refreshSetup, getCustomPrompt, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
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
          forgetHalted(it);
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
  statusTimer = setInterval(() => bg({ type: "status" }).then(onStatus), 5000);

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ zsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS a snapgentV3 session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or a snapgentV3 command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasZsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (txt.includes(ZS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / zsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not snapgentV3's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "Start agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasZsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
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
  setInterval(scheduleSweep, 1500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      promptResender.bump("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
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
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
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
  setInterval(() => {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden) return;                         // AI tab not foreground → don't parse/exec off-screen (agentLoop gates too)
    if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "command leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
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
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return;
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
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
