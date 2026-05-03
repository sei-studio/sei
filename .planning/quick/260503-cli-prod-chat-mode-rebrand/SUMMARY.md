---
quick_id: 260503-cli-prod-chat-mode-rebrand
slug: cli-prod-chat-mode-rebrand
date: 2026-05-03
status: complete
---

# Summary: prod chat mode + rebrand + CLI + README

Bundled four coordinated changes that all touch onboarding/config surface. Single commit.

## Changes

### 1. Chat-mode separation (`config.chat.mode`)

- Added `chat: { mode: 'prod' | 'dev' }` to `src/config.js` Zod schema, default `'prod'`.
- `src/llm/orchestrator.js`:
  - New `PROD_CHAT_GUIDANCE` and `DEV_CHAT_GUIDANCE` system-prompt fragments. Prod fragment instructs the model: only `say` reaches the player; keep `say` ≤15 words / one line; use `say` frequently throughout a loop, not just start/end.
  - `chatModeGuidance` constant chosen at orchestrator construction; appended to both `cachedSystemBlocks` and `cachedCombinedSystemBlocks`. Bytes-stable per mode so prompt cache holds.
  - Two narration→`bot.chat` paths now gated on `chatModeGuidance === DEV_CHAT_GUIDANCE`:
    - terminal text-only response (line ~620 in orchestrator)
    - mid-task narration text alongside tool_uses (line ~635)
  - `say` tool-call paths and `capHitLine` left unchanged (player-facing by design).
- Result: in prod mode the model's reasoning text stays in console (`[chat->]` log) but only `say()` lines reach Minecraft chat.

### 2. Rebrand: Sei = framework, character = Sui

- `config.example.json`: `username` and `persona.name` defaults changed from `"Sei"` to `"Sui"`. New `chat.mode = "prod"` block added.
- `.planning/PROJECT.md`: opening section reworded — Sei is a *framework* for running custom personas; the character is user-named (default `"Sui"` in the example config).
- Source code intentionally untouched. `[sei]` log prefix and `"Sei online"` status messages refer to the framework, not the character. `bot.chat` already uses `config.persona.name`.

### 3. `sei` CLI

- New `src/cli/index.js` (zero new deps — built on `node:readline/promises`, `node:fs`).
- Light-blue ANSI theme (`\x1b[94m` / `\x1b[1m`).
- Banner: `═════ Sei (Dev Mode CLI) ═════`.
- Subcommands:
  - `sei` (no args, no config) → onboarding flow.
  - `sei` (no args, config exists) → menu (start / config / quit).
  - `sei start` → spawns `node src/index.js --lan` as child process so the CLI stays light.
  - `sei config` → re-runs onboarding using existing values as defaults.
  - `sei help` → usage.
- Onboarding questions (in order): your name, MC username, character name, one-line backstory, tone (4 options), Anthropic API key (optional, env-var fallback documented), chat mode (messages-only=prod / full=dev).
- Writes merged `config.json`; pre-seeds `OWNER.md` `preferred_name` field if the file doesn't exist yet.
- `package.json`: added `bin.sei` field and `npm run sei` script.

### 4. README rewrite

Five sections per spec:
1. Project basics — Sei is a framework for running custom personas in Minecraft.
2. Quickstart — clone → `npm install` → `npx sei` → `npx sei start`.
3. Progress — todo list with phases 1, 2, 2.1 marked done; Phase 4 GUI flagged as incoming.
4. Credits — mineflayer, mineflayer-pathfinder, mineflayer-pvp, mineflayer-auto-eat, Anthropic SDK, ollama-js, Zod.
5. Contributing — closed PRs at the moment, reach out via X [@oue2x2](https://x.com/oue2x2).

## Files Touched

- `src/config.js` — added `chat` block to schema.
- `src/llm/orchestrator.js` — guidance fragments + chatModeGuidance gating.
- `src/cli/index.js` — new file.
- `package.json` — bin entry + script.
- `config.example.json` — defaults to "Sui", added `chat.mode`.
- `.planning/PROJECT.md` — framework vs character clarification.
- `README.md` — rewrite.

## Verification

- `node --check` passes on every modified JS file.
- `node src/cli/index.js help` renders correctly.
- `loadConfig('./config.example.json')` parses with new schema (verified inline: `chat.mode=prod`, `persona.name=Sui`, `username=Sui`).
- Phase 3 loop verifications still pass: `mutation-free` OK, `tool-pairing` OK.

## Out of Scope

- `config.json` (the user's local config) is gitignored and was not modified — they re-onboard via `sei config` to pick up new defaults and `chat.mode`.
- Source-code references to "Sei" in log/status strings (e.g. `[sei]`, `"Sei online"`) were left as framework identifiers, not character identifiers.
- Phase-4 Electron GUI replaces this CLI later; the CLI is a deliberate stopgap.
