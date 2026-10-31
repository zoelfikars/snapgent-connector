# Calibration: teaching the extension a chat site instead of coding it

Status: **design, agreed in discussion; nothing below is built yet** except phase 0.

## Why

Today every supported site has a hand-written adapter (`legacy/providers/*.js`, ~8,000 lines) full of selectors
and site quirks. Sites change their markup often (ChatGPT, Gemini and Meta each broke at least once while this
project was being tidied), and every change means editing code, shipping a release and, for a fork, merging it.

The maintainer does not want to chase 12 sites, and the users are the maintainer and a few friends. So:

> **The user teaches the extension where the parts of a chat page are, once, in a short calibration. What it
> learns is stored as data. The code knows no site.**

## Decisions

| # | Decision |
|---|---|
| 1 | Calibration first. The extension has no built-in knowledge of any chat site. |
| 2 | What is learned is a **profile**: JSON per site, kept in the browser, exportable and importable. |
| 3 | The repository may ship seed profiles in `profiles/*.json`. They are data, so merging upstream never conflicts with code, and a community fix is a one-file PR. |
| 4 | Calibration never sends a test message. Writing is verified by typing into the composer and reading it back (then clearing); sending is verified on the first real message. |
| 5 | The "switch AI" list in the bar (`AI_SITES`) stays: it is a shortcut, not an adapter. |
| 6 | The old adapters are **removed first** (phase 0) so the extension runs cleanly, then the calibrated engine is built, then the last old code is deleted. They are not kept as a fallback. |
| 7 | The old per-site features listed under "Deliberately not preserved" are **not carried over**. This is a decision, not an oversight. |

## What the user picks, and what is derived

| Role | How it is learned |
|---|---|
| Composer (text box) | **Picked**: one click. Then a write/read-back test. |
| Send button | **Picked**: one click, or "use Enter". |
| One assistant reply | **Picked**: one click on any existing reply. The other replies are found by the repeating pattern around it. |
| The part of the reply to read | **Previewed**: the text we would read is shown. If it includes reasoning, toolbars or labels, the user clicks the right inner part. |
| User messages | Derived: turns that are not assistant replies. Optional pick when that is wrong. |
| Stop button | Derived: learned when the send button changes while generating. |
| Composer card (for the bar and the cover) | Derived: the nearest ancestor that visually contains composer and send button. Optional pick. |
| Where chips go | Derived: inside the reply container. |

Calibration is at most four steps and needs one existing conversation with one reply (or is finished after the first
message). It is started from the bar ("Calibrate this site") and any single role can be re-done on its own.

## Calibration flow

1. **Composer.** The page dims, the element under the cursor is outlined, one real click picks it. The extension
   writes a short test string, reads it back, clears it. If it did not take, the engine tries the next writing
   method (native setter, paste, `insertText`, `beforeinput`) and remembers the one that worked.
2. **Send.** Click the send button, or choose "Enter sends".
3. **Reply.** Click any assistant reply. The engine finds the sibling pattern and counts how many replies it sees.
4. **Preview.** Shows the text that would be read from the last reply. "Looks right" saves; otherwise the user
   clicks the inner part that is the answer, and the preview refreshes.
5. Save the profile for this site. The bar shows "Calibrated".

Clicks must be real (`event.isTrusted`) so a page script cannot pick elements on the user's behalf. The picker is
rendered in the extension's own closed shadow root, like the approval dialog.

## Profile

```jsonc
{
  "version": 1,
  "site": "chatgpt.com",            // origin the profile applies to
  "name": "ChatGPT",
  "createdWith": "3.10.0",
  "composer": { "fingerprint": { ... }, "write": "paste" },
  "send":     { "fingerprint": { ... }, "enter": false },
  "reply":    { "turn": { "fingerprint": { ... } }, "body": { "fingerprint": { ... } } },
  "user":     { "turn": null },      // null = derived
  "stop":     { "fingerprint": { ... } },   // learned, may be absent
  "card":     { "fingerprint": { ... } }    // optional
}
```

A **fingerprint** is several weak signals, never one CSS path:

```jsonc
{ "tag": "div", "testid": "send-button", "role": "button", "aria": "Send message",
  "id": null, "text": null, "classes": ["h-8", "w-8"],           // hashed-looking classes are marked weak
  "anchor": { "testid": "composer-surface", "path": [2, 0, 1] }, // route from the nearest stable ancestor
  "siblingsOfSameKind": 1 }
```

Resolving tries the strongest signals first (`data-testid`, `role` + `aria-label`, stable `id`), then text, then the
route from the anchor. A role that resolves to the wrong number of elements is reported, not guessed.

## Health check and re-calibration

Every page load (and when a session starts) each role is resolved. If one fails, the bar says which
("Cannot find the send button") and offers **Re-calibrate: send button** for that role only. This replaces the
current "unreadable after 15 s" check.

## The engine implements the existing provider contract

`legacy/main.js` and the application layer already talk to the page through one object (`P`). The calibrated engine
is a new implementation of that same object, so nothing above it changes. Members, and where each now comes from:

| Group | Members | Source in the new engine |
|---|---|---|
| Turns | `allItems`, `isUserItem`, `isAssistantItem`, `assistantCount`, `userCount`, `lastAssistant`, `lastAssistantId`, `itemKey`, `itemText`, `classifyText`, `readAssistant`, `chatIsEmpty`, `isFreshChat`, `conversationKey`, `thinkingSel` | profile (`reply`, `user`); keys from stable attributes (`data-*id`), else position; `conversationKey` from the URL |
| Generation | `isGenerating`, `isHardGenerating`, `isBusyNow`, `streamLen`, `snapshot`, `genDebug`, `turnHalted`, `stopGeneration`, `timings` | stop button (learned) + reply text growth (`StreamSampler`); generic timings |
| Composer | `getEditor`, `editorText`, `typeAndSend`, `installSendHooks`, `setInputLock`, `enforceComposer`, `ensureComposerReady`, `composerFrame`, `barAnchor`, `barMount`, `coverTarget` | profile (`composer`, `send`, `card`); writing method probed and remembered |
| Chips | `findToolBlockSpot`, `chipAtItemLevel`, `chipAnchor`, `chipAppend`, `chipTrailRef` | blocks found by content (`{"command"…`), chips placed in the reply container |
| Errors | `scanError`, `isTooLongMsg`, `isBusyMsg`, `findContinueBtn`, `clickContinueBtn` | generic text patterns only (see "not preserved") |
| Identity | `id`, `displayName`, `supportsVision`, `sendRetryLimit`, `sendCharBudget`, `reliableCounts`, `promptExtra`, `resendSystemEvery`, `unstableWarning`, `modeWarning`, `describeLayout`, `init` | profile metadata and neutral defaults |

The existing contract tests (`test/sites-contract.test.js` style: count turns, read the call, ignore reasoning and
chrome, find the composer, hide the block, stop control) are the acceptance suite for the engine.

## Deliberately not preserved

Per the maintainer: the old per-site features are not kept. Some may return later as generic features; none is
promised. Recorded here so the loss is explicit:

- **Every site-specific adapter**, including its selectors, timings and workarounds.
- **Images / vision.** `attachImages`, `supportsVision` and the `screen_capture` image round-trip (Gemini, DeepSeek
  Vision tab, GLM, Arena, Kimi, Meta, Qwen). Tools that return images will return text only until a generic
  attachment method exists.
- **ChatGPT**: the layout table (`chatgpt-layouts.js`), the main-world CodeMirror reader (`chatgpt-cm.js`), the
  re-statement cadence (`resendSystemEvery`) and the provider note (`promptExtra`).
- **Qwen**: the main-world network hook (`qwen-net.js`) and the Monaco code cache.
- **Arena**: Battle / Side-by-Side gating and reading candidate A of the A/B carousel.
- **DeepSeek**: separating reasoning from the answer by its markup, the Search toggle handling, Vision-tab detection.
- **Gemini**: the wedged-stop recovery.
- **Meta**: the Lexical-specific writer (replaced by the generic probe), mode and menu handling.
- **Kimi / GLM / Qwen / Arena / Meta**: per-site chip anchoring (`chipAppend`, `chipTrailRef`, `chipAnchor`).
- **Per-site "unstable" badges and mode warnings** (`unstableWarning`, `modeWarning`).
- **Per-site Continue / regenerate handling** (`findContinueBtn`, `clickContinueBtn`, `turnHalted` quirks): a
  truncated reply is handled by the generic retry path only.
- **Captcha and overlay detection** per site (a generic "dialog is covering the page" check may replace it).
- The Gemini chip-column CSS rule and other per-site rules in `overlay.css`.

What stays: the bar, the "switch AI" shortcut list, MCP target and settings, skills, the approval dialog, the bridge,
the whole application layer (agent loop, tool runner, session logic) and the generic page helpers (`StreamSampler`,
`waitFor`, `setNativeValue`).

## Phases

0. **Remove the adapters (done first).** Replace all adapters with one *uncalibrated* provider that implements the
   contract minimally and reports "Not calibrated for this site yet", which disables Start through the existing
   `modeWarning` path. Remove the main-world scripts, the ChatGPT layout table and the tests that only exercised
   adapters. The extension builds, loads, shows the bar, connects to the bridge, switches AI, edits MCP settings
   and skills, and does nothing else. The old adapters stay recoverable from the git tag `pre-calibration`.
1. **Spike, ChatGPT and Gemini.** Profile format, fingerprint and resolver, the engine for the contract above, no UI
   (profiles written by hand from the saved fixtures). Acceptance: the contract suite passes on the saved page
   captures of both sites with profiles that were not tuned to the engine's quirks; plus a live check by the maintainer.
   Outcome is a go / no-go, with a list of anything the engine could not do generically.
2. **Calibration UI**: picker, write/read-back test, preview, per-role re-calibration, health check, storage,
   export / import, seed profiles from `profiles/`.
3. **Delete the last old code** once calibrated sites work (leftover helpers, tests, the registry fields that only
   served adapters).
4. **Unknown sites.** Any chat site can be used by calibrating it; the match list becomes the user's choice
   (optional host permission) instead of a fixed registry.

## Risks and open questions

- The engine must equal the old adapters on the delicate parts: reading a reply (not its reasoning), knowing a
  generation is finished, and a stable key per turn on virtualised lists. Phase 1 exists to find out early.
- Sites that render replies in shadow DOM, iframes or canvas cannot be picked and are out of scope.
- Dropping vision is a real loss for `screen_capture`; accepted for now.
- Fingerprints can still go stale; the health check and per-role re-calibration are the answer, not a promise
  that calibration is permanent.
- Where seed profiles come from: they are produced by calibrating, exporting and committing, never written by hand.
