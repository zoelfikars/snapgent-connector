# Calibration: teaching the extension a chat site instead of coding it

Status: **design, agreed in discussion. Phases 0, 1 and 2 are built (see "Phase 1 results" and "Phase 2: what exists"); seed profiles, deleting the last old code and unknown sites are not.**

## Why

Every supported site used to have a hand-written adapter (~8,000 lines, in the git tag `pre-calibration`) full of selectors
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
| One assistant reply | **Picked**: one click on any existing reply. |
| One of the user's own messages | **Picked**: one click. Needed (phase 1 finding): a reply can only be told apart from a message by comparing the two. |
| The part of the reply to read | **Previewed**: the text we would read is shown. If it includes reasoning, toolbars or labels, the user clicks the right inner part. |
| Stop button | Derived: learned when the send button changes while generating. |
| Composer card (for the bar and the cover) | Derived: the nearest ancestor that visually contains composer and send button. Optional pick. |
| Where chips go | Derived: inside the reply container. |

Calibration is at most five clicks and needs one existing conversation with one message and one reply (or is finished after the first
message). It is started from the bar ("Calibrate this site") and any single role can be re-done on its own.

## Calibration flow

1. **Composer.** The page dims, the element under the cursor is outlined, one real click picks it. The extension
   writes a short test string, reads it back, clears it. If it did not take, the engine tries the next writing
   method (native setter, paste, `insertText`, `beforeinput`) and remembers the one that worked.
2. **Send.** Click the send button, or choose "Enter sends".
3. **Reply and your message.** Click any assistant reply, then any message of your own. The engine finds what tells the two kinds of turn apart (an attribute, a tag, a class) and counts the turns of each kind it now sees.
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

The page layer (`src/page`) and the application layer talk to the page through one object, the provider. The calibrated engine
is an implementation of that object (the extension also has an *uncalibrated* one, in `src/page/provider.js`), so nothing above it changes. The members
below are the old, wider contract; what the engine implements today is what `src/page` uses. Members, and where each now comes from:

| Group | Members | Source in the new engine |
|---|---|---|
| Turns | `allItems`, `isUserItem`, `isAssistantItem`, `assistantCount`, `userCount`, `lastAssistant`, `lastAssistantId`, `itemKey`, `itemText`, `classifyText`, `readAssistant`, `chatIsEmpty`, `isFreshChat`, `conversationKey`, `thinkingSel` | profile (`reply`, `user`); keys from stable attributes (`data-*id`), else position; `conversationKey` from the URL |
| Generation | `isGenerating`, `isHardGenerating`, `isBusyNow`, `streamLen`, `snapshot`, `genDebug`, `turnHalted`, `stopGeneration`, `timings` | stop button (learned) + reply text growth (`StreamSampler`); generic timings |
| Composer | `getEditor`, `editorText`, `typeAndSend`, `installSendHooks`, `setInputLock`, `enforceComposer`, `ensureComposerReady`, `composerFrame`, `barAnchor`, `barMount`, `coverTarget` | profile (`composer`, `send`, `card`); writing method probed and remembered |
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
   and skills, and does nothing else. The old adapters, the saved page captures (`extension/test/fixtures/`) and the contract test (`test/sites-contract.test.js`) stay recoverable from the git tag `pre-calibration`; phase 1 restores what it needs with `git show pre-calibration:<path>`.
1. **Spike, ChatGPT and Gemini.** Profile format, fingerprint and resolver, the engine for the contract above, no UI
   (profiles written by hand from the saved fixtures). Acceptance: the contract suite passes on the saved page
   captures of both sites with profiles that were not tuned to the engine's quirks; plus a live check by the maintainer.
   Outcome is a go / no-go, with a list of anything the engine could not do generically.
2. **Calibration UI**: picker, write/read-back test, preview, per-role re-calibration, health check, storage,
   export / import, seed profiles from `profiles/`.
3. **Delete the last old code** *(done)*: chips and the per-site rules of `overlay.css`, `legacy/`, and the members of the provider contract nothing reads any more.
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

## Phase 1 results (spike)

Built: `src/infrastructure/calibration/` (selector learning, profile, engine) and a loader in `src/page/provider.js`
that uses a stored `zsProfiles[<host>]` when there is one. No UI yet: profiles are learned in tests from simulated
clicks and stored by hand.

**Acceptance.** `test/calibration.test.js` learns a profile from five clicks (text box, send button, a reply, a message
of the user's, optionally the part of the reply to read) on three pages and runs the contract on it: counts, telling
user from assistant turns, reading the tool call, the marker in the user's turn, the composer and its card, the stop control, a fresh chat, writing and sending (button and Enter), and a missing part
named by the health check. ChatGPT (captured 2026-10 reply chain), Gemini (captured reply structure) and Meta
(captured Lexical composer structure) all pass, and the real content script (`test/content-script.test.js`) boots with
a stored profile and reads the page through it. 41 + 4 tests; mutations of each rule make them fail.

**What the spike taught (design changes, already applied above):**
- A reply cannot be selected in isolation. The turn is the outermost element around the click that differs from the
  user's turn, so a second pick (a user message) is required.
- Instance-specific values must be generalised. Captured ChatGPT turns carry `data-content-search-unit-key="fallback-turn-1:1:assistant"`;
  matching it exactly finds only that turn. Any value with a digit is treated as per-instance and matched by its
  stable word (`[…$=":assistant"]`). Generated class names (`block-BQZwFn`) are never used.
- Hiding the raw command block must count text without markup whitespace, or pretty-printed pages never qualify as "chrome".
- Writing needs a short settle (150 ms) before input reaches a rich editor, then the methods in turn
  (paste, `insertText`, `beforeinput`); the one that worked is remembered. This is the Meta lesson, now generic.

**Evidence limits (be honest about them).** The pages are captures of the reply part only; the composers and send buttons
of the ChatGPT and Gemini pages are written to match what was reported, not captured. Nothing here has run on a live
site, and nine sites have not been tried. The Meta page is the only one with a captured composer.

**Not done in the spike, and the open gaps:**
- Reasoning is not separated from the answer unless the user picks the inner part (the preview step in phase 2).
- Stop is found by an `aria-label`/`data-testid`/`title` matching *stop|cancel|halt|arrêter* inside the composer card;
  sites that label it otherwise need a `profile.stop.selector` (set by calibration, not yet learnt).
- Turn keys come from an id-like attribute when present, else none; virtualised lists on sites without one are untested.
- No `scanError` / limit detection, no continue handling, no images (all deliberately dropped).
- Calibration works only on a conversation that already has a message and a reply; a brand-new chat has to be started first.
- Site-specific CSS from the old adapters is still in `overlay.css` and still applies by accident on some sites.

**Verdict: go.** The profile-from-clicks approach reproduces the parts of the adapter contract that the old contract
tests covered, on all three pages, with no site-specific code. The remaining risk is live pages, which only phase 2 (a real
picker) can test. Next: phase 2.

## Phase 2: what exists

- **Picker** (`src/ui/picker.js`): while it runs the page gets none of the user's clicks; one genuine (`isTrusted`) click
  chooses the element, Escape cancels, a fabricated click chooses nothing. Our own panel and control bar are not pickable.
- **Wizard** (`src/ui/calibration-wizard.js`, closed shadow root): text box, send button (or "Enter sends"), a reply, one of
  your messages; then a preview of the text it would read from the reply (with "Pick just the answer" when it includes
  labels or buttons); then a write-and-read-back check of the text box that sends nothing; then save. "Back", "Cancel"
  and Escape work throughout. One part can be redone alone (text box, send button, or reply + message), keeping the rest.
- **Storage and files** (`src/application/profile-store.js`): profiles live in extension storage under `zsProfiles[host]`.
  The menu entries **Calibrate this site / Export / Import / Remove** are in the "switch AI" menu; an import is accepted
  only for the host it was made for. Storing or removing a profile switches the provider without a reload.
- **Bar**: on a site that is not calibrated, or whose profile stopped matching the page, the only action is
  **Calibrate** (with the reason as the message; a missing text box or send button redoes just that part).

Not in phase 2: seed profiles shipped in `profiles/`, unknown sites, learning the stop button from a send, and deleting
the leftovers listed under phase 3.

## Review before saving

- **Text box**: a click on or around the field resolves to the real field (the field, or the one visible field inside the box that was clicked, looked for a few levels up). Only when there is none, or several, is the click refused.
- **Review overlays**: after the clicks, every turn of the chat is marked on the page ("You" green, "AI reply" blue), the part read is marked "Read from here", and the box the bar will sit in is yellow. Warnings are listed when nothing was found or when the part read leaves out code blocks of the reply (where commands are).
- **Pick the bar's box**: from the review the user can click the box around the text box (must contain it); it is stored as `card` in the profile.

## Shipping default calibrations

The extension carries calibrations of its own so that a new user does not have to teach every site. They live in
`extension/profiles/default-calibrations.json` and are compiled into the content script (no extra file to fetch at run time).

To update them: calibrate the sites by hand, choose **Export all calibrations** in the "switch AI" menu, and save the file over
`extension/profiles/default-calibrations.json`. A site the user has not calibrated is read with the profile in that file; a calibration the
user made always wins, and a user's profile that has stopped matching the page falls back to the shipped one. The file is data about page
layouts only, never about a conversation: look through it before committing it.
