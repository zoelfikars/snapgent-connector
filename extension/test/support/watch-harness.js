// A scripted chat page + fake clock for ResponseWatcher tests. `at(ms, patch)` schedules a change to
// what the "page" shows; sleeping advances the fake clock and applies due changes.
export function createWatchHarness({ initial = {}, timings = {}, tabs = {}, reliableCounts = false, extras = {} } = {}) {
  let now = 1000;
  const events = [];
  const diags = [];
  const page = { gen: false, reply: "", thinking: "", item: { id: "t1" }, lastId: "t1", count: 1, error: null, tooLong: false, halted: false, continueBtn: false, ...initial };
  const tab = { hidden: false, parkMs: 0, stopped: false, ...tabs };
  const sendToken = { value: "t0" };
  const apply = () => {
    for (const e of events) if (!e.done && e.at <= now - 1000) { e.done = true; Object.assign(page, typeof e.patch === "function" ? e.patch(page) : e.patch); }
  };
  const clock = {
    now: () => now,
    sleep: async (ms) => { now += ms; apply(); },
  };
  const chat = {
    isGenerating: () => page.gen,
    readAssistant: () => ({ item: page.item, reply: page.reply, thinking: page.thinking }),
    lastAssistantId: () => page.lastId,
    assistantCount: () => page.count,
    scanError: () => page.error,
    turnHalted: () => page.halted,
    isTooLongMsg: () => page.tooLong,
    findContinueBtn: () => (page.continueBtn ? {} : null),
    reliableCounts,
    ...extras,
  };
  return {
    page, tab, sendToken, diags, clock,
    at(ms, patch) { events.push({ at: ms, patch, done: false }); return this; },
    deps: {
      chat,
      visibility: {
        isHidden: () => tab.hidden,
        parkHidden: async () => { tab.hidden = false; now += tab.parkMs; apply(); return tab.parkMs; },
      },
      isStopped: () => tab.stopped,
      sendToken: () => sendToken.value,
      clock,
      timings: { RESPONSE_TIMEOUT_MS: 300000, STABLE_MS: 9000, WARMUP_MS: 45000, REASON_NOREPLY_MS: 90000, ...timings },
      knowsTool: (name) => name === "read_file",
      catalogueSize: () => 1,
      describeLayout: () => ({ layout: null, users: 1, assistants: 0 }),
      diag: (event, data) => diags.push([event, data]),
    },
    elapsed: () => now - 1000,
  };
}
