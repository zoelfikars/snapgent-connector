# AGENTS.md

Instructions for AI agents working in this repository.

## What this is

Browser extension (`extension/`, Manifest V3, vanilla JS ESM) + local Python bridge (`server/`) that turn a normal AI chat into a coding agent for VS Code over MCP. Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Layout

- `extension/src/domain/` — pure logic (parsing, prompts, budget). No DOM, no browser API, no I/O; imports only from itself. Enforced by tests.
- `extension/src/application/` — the agent loop, sessions, tool running, written against ports.
- `extension/src/page/`, `src/ui/`, `src/entry/` — browser wiring, the bar, dialogs, content-script composition.
- `extension/src/infrastructure/` — the calibrated engine that reads a chat page from its profile ([docs/CALIBRATION.md](docs/CALIBRATION.md)).
- `extension/src/sites/registry.js` — the one list of supported AI sites; manifest, background and popup are generated from it.
- `server/snapgent.py` — one program: the bridge, or the Snapgent MCP server with `--mcp`.
- `server/snapgent_bridge/`, `server/snapgent_mcp/` — bridge and VS Code server implementations.
- `extension/test/`, `tests/` — JS (node:test) and Python (unittest) suites.

## Commands

Run inside `extension/` unless noted:

- `npm test` — extension tests. Run after every change.
- `npm run lint` — eslint over src, build, test.
- `npm run build` — bundles to `dist/chrome` and `dist/firefox`.
- `python -m unittest discover -s tests -t .` — Python tests, from the repo root.

## Rules

- Every source file starts with an SPDX header: `// SPDX-License-Identifier: GPL-3.0-or-later` (`#` in Python).
- Keep the layering: domain stays pure; nothing below imports page or ui. `extension/test/architecture.test.js` fails on violations.
- Comments explain why, in English, in full sentences. Keep modules small enough to hold in your head.
- Add a test for every new behavior, in the style of the suite it belongs to.
- Commits: `<type>: <summary>` — types feat, fix, docs, refactor, test, chore; summary imperative, max 72 chars. Stage only relevant files.
