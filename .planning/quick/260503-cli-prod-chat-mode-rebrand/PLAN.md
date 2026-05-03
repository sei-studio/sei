---
quick_id: 260503-cli-prod-chat-mode-rebrand
slug: cli-prod-chat-mode-rebrand
date: 2026-05-03
status: in-progress
---

# Quick Task: prod chat mode + rebrand + CLI + README

Bundles four coordinated changes that all touch the same surface (config + onboarding + docs).

## Scope

### 1. Chat mode separation (`config.chat.mode`)

- Add `config.chat.mode: 'dev' | 'prod'` (default `'prod'`).
- **Dev mode (current behaviour):** every natural-language string the model emits — `say()` tool calls AND mid-text/terminal narration — reaches in-game chat. Useful for debugging because the model's reasoning is visible.
- **Prod mode (new):** only `say()` tool calls reach in-game chat. The model's `text` reasoning stays in the console log only. System prompt also instructs the model to keep `say` lines short (≤15 words, one line, like player chat) and to call `say` frequently throughout a loop — at start, when noticing/finding things, when blocked, before/after major actions, at completion — not just at start and end.
- Wiring: orchestrator gates the two narration→`bot.chat` paths (mid-text and terminal-text) on `config.chat.mode === 'dev'`. The system prompt prepends a prod-mode reminder when `mode === 'prod'`. `say` tool calls flow unchanged.

### 2. Wording: Sei = framework, character = Sui

- `config.example.json`: `persona.name` = `"Sui"`, `username` = `"Sui"` (defaults reflect that the bot character is user-named, not "Sei").
- `.planning/PROJECT.md` + `README.md`: clarify Sei is the framework name; the character is set via config.
- Source code intentionally untouched — `[sei]` log prefix and "Sei online" status messages refer to the framework, not the character. `bot.chat` already uses `config.persona.name`.

### 3. `sei` CLI

- New `src/cli/index.js`, registered as `bin.sei` in `package.json` (so `npm link` or `npm i -g .` exposes the command).
- Light-blue ANSI theming (no new deps; raw `\x1b[94m` / `\x1b[1m` codes).
- Banner: `==== Sei (Dev Mode CLI) ====`.
- **First run / `sei` with no config:** runs onboarding — questions: player display name, player MC username (→ `owner_username`), character name (→ `persona.name` + `username`), tone (friendly/sarcastic/serious/curious), chat mode (messages-only=prod / full=dev). Anthropic API key prompted but optional (env-var fallback documented). Writes `./config.json` preserving any existing keys (api key, ports, etc.).
- **Post-onboarding `sei`:** banner + interactive menu — start / config / quit.
- **`sei start`:** equivalent of `node src/index.js --lan` — auto-discovers a LAN world.
- **`sei config`:** re-runs onboarding using existing values as defaults.
- Uses Node built-ins only: `readline/promises`, `fs`, `path`. Zero new deps.

### 4. README rewrite

Five sections: (1) project basics — Sei is a framework for running custom personas in Minecraft; (2) quickstart — clone → `npm install` → `sei` → `sei start`; (3) progress — todo with phase 4 GUI incoming; (4) credits — mineflayer, mineflayer-pathfinder, mineflayer-pvp, mineflayer-auto-eat, Anthropic, Ollama; (5) contributing — closed PRs for now, reach out via X @oue2x2.

## Files

- `src/config.js` — add `chat.mode` to schema (new top-level optional block, default `prod`).
- `src/llm/orchestrator.js` — gate two narration→chat paths; add prod-mode system prompt fragment.
- `src/cli/index.js` — new file (CLI entrypoint).
- `package.json` — add `bin.sei` field; `start:lan` script for parity.
- `config.example.json` — update defaults to "Sui".
- `.planning/PROJECT.md` — clarify Sei = framework.
- `README.md` — full rewrite per spec.

## Verification

- `node --check` on every modified `.js` file.
- `node src/cli/index.js --help` exits cleanly and prints help.
- Spot-check `loadConfig()` parses example with new `chat.mode` field.
- Read-through of orchestrator diff to confirm only narration paths gate, not `say()` paths.
