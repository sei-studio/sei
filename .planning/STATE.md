---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-05-18T03:22:20.646Z"
progress:
  total_phases: 17
  completed_phases: 9
  total_plans: 60
  completed_plans: 50
  percent: 83
---

# State: Sei

## Project Reference

- **Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.
- **Current Focus:** Phase 9 — Custom bot skins via CustomSkinLoader

## Current Position

Phase: 9 (Custom bot skins via CustomSkinLoader) — EXECUTING
Plan: 2 of 8
Wave 1 done (shared contracts). Next: Wave 2 (Plan 09-02) — per-persona skin store + applySkin/removeSkin/uploadSkinPng/searchMojangSkin handlers in main.

- **Phase:** 09
- **Plan:** 1/8 — Plan 01 complete; Plan 02 (skin store handlers) next
- **Status:** Executing Phase 9
- **Progress:** [████████░░] 83%
- **Next action:** `/gsd-execute-phase 9` Plan 02 — skin pipeline backend (Plan 01 contracts now locked)

```
[DONE] Phase 1    Bot Substrate
[DONE] Phase 2    Two-Layer LLM Loop
[DONE] Phase 2.1  Expand Actions & Game State
[DONE] Phase 3    Memory & Persistence
[DONE] Phase 03.1 Behavior Polish & AI/Game Decoupling
[____] Phase 4    Electron GUI & Packaging
[DONE] Phase 5    Debug log readability (from 999.2)
[DONE] Phase 6    Scavenging redesign (from 999.1)
[DONE] Phase 7    Pillar-up / scaffolding (from 999.3)
[CTX_] Phase 8    Windows cross-platform compatibility (← next, context captured)
[____] Phase 9    Custom bot skins via CustomSkinLoader (context already captured)
```

> Sequencing note (2026-05-07): user elected to land Phases 5/6/7 BEFORE Phase 4 (Electron GUI). Phase 4 stays in roadmap order but is queued behind the promoted backlog work — Phase 5 is the next plan-phase target.

## Performance Metrics

- Requirements coverage: 36/36 (100%)
- Phases defined: 5 (1, 2, 2.1, 3, 03.1)
- Plans executed: 22
- Phases complete: 5 (Phase 1, 2, 2.1, 3, 03.1)
- Phase 03.1 Bucket A gap-closure: 17/17 items closed (plans 07–10)
  - Plan 07: D-NEW-TONE-1, D-NEW-DM-1/2/3, D-W-8/D-NEW-TONE-2 (3 items)
  - Plan 08: D-NEW-MEM-2, D-NEW-MEM-3, D-W-9, WR-05, WR-06 (5 items)
  - Plan 09: NEW-W-A, D-H-15, D-H-16, D-W-7, WR-07 (5 items)
  - Plan 10: WR-01, WR-02, WR-04, WR-08 (4 items)

## Accumulated Context

### Decisions (from PROJECT.md / research)

- Two-layer LLM: Haiku 3 personality + Ollama Qwen 2.5 movement, natural-language hand-off
- Closed Zod-typed action registry; LLM never generates code or coordinates
- Event-sourced FSM with priority queue; one outstanding action tracked by AbortController
- better-sqlite3 for persistence; LLM-directed compaction at semantic boundaries
- Three-process Electron: main ↔ renderer (React) ↔ utilityProcess (mineflayer + orchestrator)
- Screenshot / vision deferred to v2 (requires Haiku 3.5 + macOS permission UX)
- mineflayer-pathfinder goals accessed via default export interop (named ESM export unavailable)
- mineflayer-auto-eat plugin exposed as 'loader' named export, not default
- chat.js uses bot.username for addressed-check to match actual in-game bot name
- Default Anthropic model claude-haiku-4-5-20251001 (Haiku 3 retired April 2026, D-20)
- Default Ollama model qwen3.5:7b-instruct (non-instruct emits thinking traces, D-21)
- ANTHROPIC_API_KEY env-var fallback supported in loadConfig (schema stays strict)
- Per-call new Ollama() instance to isolate abort() scope (Pitfall 3)
- Anthropic cached system prefix: 3 blocks, cache_control ephemeral on LAST block (D-18)
- Hop counter is chain-scoped (keyed by _chainId) not per-dispatch — closes LLM-04 leak across FSM completion re-entries
- Personality LLM tools restricted to say/handOffToMovement/setGoals; mineflayer registry actions reserved for movement layer (D-04)
- setGoals lives in the registry but movement subRegistry filters it out
- FSM re-queue branch (lower-priority during higher-priority hold) keeps `processing = true`; the in-flight action's trailing `setImmediate(processNext)` drain handles re-queued items naturally (WR-01, plan 03.1-10)
- Loop's abortController is swappable via `_setAbortController(c)` setter on a mutable closure-local; replaces `Object.defineProperty(loop, 'abortController')` (WR-02, plan 03.1-10)
- External FSM signal is captured on `loop._externalSignal` and re-bridged on every `replaceAbortController` via `bridgeExternalAbort(loop)`; second-turn external aborts route to the swapped controller (WR-02, plan 03.1-10)
- `sei:attacked` arriving mid-loop preserves any pending owner-chat into `pendingAttack.preservedInterrupt`; finally re-enqueues the chat at P1 after the P0 attack — priority queue handles ordering (WR-04, plan 03.1-10)
- `composeSeedBlocks` plumbs an optional `logger = console` so the AFFECT.md catch can narrow to `ENOENT`/`EACCES` and warn on coding-bug errors (WR-08, plan 03.1-10)
- electron-builder.yml `appId: com.sei.app` LOCKED (2026-05-17, Phase 8 Plan 01 Task 2) — conventional reverse-DNS, no domain-ownership coupling. Irrevocable per threat T-08-01 (post-release change strands every Keychain/DPAPI entry).
- electron-builder.yml `productName: Sei` preserved — drives `%APPDATA%\Sei\` (Windows) / `~/Library/Application Support/Sei/` (mac) / `~/.config/Sei/` (linux) userData resolution. Matches `src/bot/cli/index.js:electronUserDataDir` hardcoded `APP = 'Sei'`.
- mac.identity TODO in electron-builder.yml (Apple Developer cert) explicitly NOT closed by Phase 8 — separate concern, remains user-side blocker for future signing phase.
- Phase 8 audit pattern established: 08-HOTSPOTS.md as 24-row table with SAFE/SUSPECT/FIX-INLINE/DEFER-TO-LIVE status; every DEFER-TO-LIVE row maps directly to a Wave 2 or Wave 3 verification checklist item.

### Todos

- Plan and execute Phase 2 (Two-Layer LLM Loop)
- Parallel spike: Qwen tool-calling reliability (de-risk Phase 2)
- Parallel spike: native-module packaging (de-risk Phase 4)
- Parallel task: start Apple Developer / Windows EV cert applications (lead time)

### Roadmap Evolution

- Phase 2.1 inserted after Phase 2: Expand action registry beyond goTo/setGoals and surface inventory/surroundings/position to personality LLM as text (URGENT). Conflict-checked against Phase 3 (Memory) and Phase 4 (GUI) — no overlap; Phase 3 still owns SQLite persistence and compaction.
- Phase 3.1 inserted after Phase 3: Behavior polish and AI/game decoupling refactor (analysis-driven from logs/) (URGENT)
- Phase 5 promoted from backlog 999.2 (2026-05-07): Debug log human readability — event-per-line emission. Reason: needed for debugging Phases 6/7 (scavenging, scaffolding) work.
- Phase 6 promoted from backlog 999.1 (2026-05-07): Scavenging redesign — veined tallying + smart_find + find(). Reason: user explicitly asked to land before Phase 4. Recommend `/gsd-discuss-phase 6` first (three coupled subsystems).
- Phase 7 promoted from backlog 999.3 (2026-05-07): Pillar-up / scaffolding behavior. Reason: bot can't reach elevated targets — placeBlock/equip wiring missing. Depends on Phase 6 for block-id resolution.
- Phase 8 added (2026-05-17): Windows cross-platform compatibility. Reason: Sei only tested on macOS so far; Phase 9's setup-wizard auto-installer needs known-good cross-platform behavior in the rest of the app first.
- Phase 9 added (2026-05-17): Custom bot skins via CustomSkinLoader. Reason: promoted from quick task 260517-frz after research + 4 ruled-out alternatives (signed-texture injection, prismarine-proxy, Paper sidecar, paid Mojang account) showed the only path to "host sees custom skin on bot in own LAN world" without managing a server is a client-side mod with Sei automating its install. Depends on Phase 8. Full research preserved in `.planning/phases/09-.../RESEARCH.md`.

### Blockers

- None

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260429-nyx | API-only fallback → single combined Haiku call + leading-edge attack throttle | 2026-04-30 | 6468a3e |   | [260429-nyx-update-api-only-fallback-to-single-combi](./quick/260429-nyx-update-api-only-fallback-to-single-combi/) |
| 260429-ons | in_flight snapshot field + follow gates on action lifecycle + owner-chat preempts in-flight work + tighter action error strings + one-movement-type-per-turn rule | 2026-04-30 | 697f9a9 |   | [260429-ons-in-flight-snapshot-field-action-lifecycl](./quick/260429-ons-in-flight-snapshot-field-action-lifecycl/) |
| 260502-h6i | Sei latency + diary hallucination fixes: cache_control on last tool, no-op compaction skip, remove look tool, owner-chat preempt (sei:chat_received), stop-verb pre-LLM hard cancel | 2026-05-02 | ce7d90e |   | [260502-h6i-fix-sei-latency-owner-chat-preempt-stop-](./quick/260502-h6i-fix-sei-latency-owner-chat-preempt-stop-/) |
| 260503-1bu | Snapshot `recent_events:` deltas (kills, inventory gains, hp loss) + `prior_task:` interrupt-resume hint so bot resumes prior task after chat interrupt without reminder | 2026-05-03 | 1bbb67d |   | [260503-1bu-add-snapshot-delta-indicators-kills-inve](./quick/260503-1bu-add-snapshot-delta-indicators-kills-inve/) |
| 260503-1sk | Exposure-filter `nearby blocks:` (no more xray), add `around feet:` 5×4×5 grouped line, expand interesting set to terrain blocks (sand, sandstone, gravel, dirt, grass_block, …), and double radius when local view is sparse — fixes "get me 10 sand" failure on beach | 2026-05-03 | 5abc8a8 |   | [260503-1sk-snapshot-blocks-only-show-exposed-non-xr](./quick/260503-1sk-snapshot-blocks-only-show-exposed-non-xr/) |
| 260503-cli | Prod/dev chat mode split (only `say` reaches chat in prod, ≤15 words) + Sei=framework / character=Sui rebrand + light-blue `sei` CLI for onboarding/start/config + README rewrite | 2026-05-03 | cfe75b0 |   | [260503-cli-prod-chat-mode-rebrand](./quick/260503-cli-prod-chat-mode-rebrand/) |
| 260504-oh9 | Fix sei CLI silent exit under npx/global-install (entrypoint guard now realpath-resolves argv[1]) + first-run gate so `sei start`/`sei config` refuse without `config.json` + README switched to `npm link` + `sei` | 2026-05-04 | fdbc8ca |   | [260504-oh9-fix-sei-cli-entrypoint-guard-silent-exit](./quick/260504-oh9-fix-sei-cli-entrypoint-guard-silent-exit/) |
| 260505-iqo | Memory & loop architecture refactor: API-only collapse (drop ollama/circuit/handOffToMovement), convoMemory module with split owner/self ring buffers + loopHistory, idle-timing split into `sei:loop_end` + 60s fallback with per-event seed prompts, strict say/think separation | 2026-05-05 | 0a35318 |   | [260505-iqo-memory-and-loop-architecture-refactor-bu](./quick/260505-iqo-memory-and-loop-architecture-refactor-bu/) |
| 260505-twx | Sei behavior fixes: chat/full mode toggle (relay [think] in chat when full), snapshot tier-aware ranking (interesting-before-terrain) + 16-entry cap, dig-by-name tool description, P0 attack reaction (abort+restart with verbal-first seed), clearer dig error strings (no held-item suffix), iteration_cap 20→30, say() cadence rule (mandatory first/last turn, optional middle) | 2026-05-05 | ea9b342 |   | [260505-twx-sei-behavior-fixes-chat-full-mode-toggle](./quick/260505-twx-sei-behavior-fixes-chat-full-mode-toggle/) |
| 260508-mun | Electron GUI fixes: hide sidebar during onboarding, drop Persona-Prompt+Log tabs, EditCharacterModal (name/desc/prompt) gated for default Sui, dedupe card name, collapsible bottom LogsBar, inline edit in Settings (no re-run onboarding), left-align Back, subtle wave-gradient bg, fix bot:summon utilityProcess regression (bot fork path now resolves to src/ in dev) + stderr-tail diagnostics on exit-before-ready | 2026-05-08 | 17f3e48 |   | [260508-mun-make-ui-and-debug-fixes-to-electron-gui-](./quick/260508-mun-make-ui-and-debug-fixes-to-electron-gui-/) |
| 260508-nkk | Two GUI regressions: (1) CharacterPage pixel-art now full-bleed wallpaper with tabs floating over it; (2) summon hang root-caused — `bootstrapWithInit` skipped `ConfigSchema.parse` so Zod defaults (seedDiaryBudgetBytes, iteration_cap, anthropic.timeout_ms) were undefined → `createDiary` threw inside `startBrain`. Compounding bug: `summon-ready` was emitted after `start()` resolved (before mineflayer's spawn event). Fix: route config through ConfigSchema.parse, move summon-ready emit into mineflayer spawn callback, add 20s wall-clock connect timeout (per CLAUDE.md "every external call has a timeout"), supervisor treats lifecycle error as terminal for summon promise so specific errors aren't masked by the 30s outer timer. Diagnosis by static analysis only — no display server / Minecraft instance available to executor; user verifies live | 2026-05-08 | 3fdf460 |   | [260508-nkk-fix-two-gui-regressions-1-generated-pixe](./quick/260508-nkk-fix-two-gui-regressions-1-generated-pixe/) |
| 260513-wc4 | Four small fixes from cactus/jungle-wood log analysis: (1) `sessionState.onPlayerJoined` idempotency guard — short-circuit when `player.uuid === activeOwnerUuid` to stop double session_start (cold→warm in one connect) which made bot say "second time meeting" after memory wipe; (2) drop default-on follow at spawn in `behaviors/follow.startFollow` — was causing body to drift toward player between LLM-issued movements; (3) `follow` tool description in orchestrator + adapter index drops "Default-on at spawn" and adds soft `unfollow`-before-tasks hint; (4) `anthropic.thinking_budget_tokens` default 1024→0 — text blocks are the chat channel now (post-`25fda20` refactor) so thinking adds latency without changing said output. Live verification (memory-wipe greeting, gather drift, latency) pending in-game test by user | 2026-05-13 | 3f45d7d |   | [260513-wc4-small-fixes-1-add-idempotency-guard-to-s](./quick/260513-wc4-small-fixes-1-add-idempotency-guard-to-s/) |
| 260513-wkd | Orchestrator loop + FSM rework. Converts the orchestrator's iteration loop from blocking-await to FSM-event-driven: long-running actions (gather, goTo, dig-cuboid, build-cuboid, attack multi-swing) dispatch in the background, the next iteration is triggered by `sei:action_complete` (P2.1) on natural completion or by P0/P1 preemption. AbortSignal threaded universally; pathfind gains a `'aborted'` result variant. New `stop` personality tool gives the model a clean "task done, hold position" verb without replacement. Cancel-semantics dispatcher implements three intents: case 1 (text-only = continue waiting, default), case 2 (`stop` tool = abandon in_flight + terminate), case 3 (new long-running tool = abort + terminate + reseed new loop with original P0/P1 trigger). P0 attack preserves the existing `pendingAttack` + `eventAddendum` reseed path. Snapshot mid-flight renders `in_flight: <name>(<args>) started=<X.X>s ago — <K/N>[, y=<currentY>]` via `inflight.getInFlightLineForSnapshot` (Phase 7 D-10 em-dash + currentY channels preserved byte-stable). New harness `scripts/verify-260513-wkd.mjs` PASSes 13/13 (B1 non-blocking dispatch, B2/B2b action_complete + priority ordering, B3 next-iteration drive, B4 case-1, B5/B5b case-2 + P1+stop cascade, B6-fire/B6-suppress case-3 gate, B7a/B7b P1 vs P0 preempt, B8 signal-tick delivery, B9 stop-with-no-inflight). `scripts/verify-phase7.mjs` regression guard still 13/13. Live in-game verification (5 scenarios: cactus + question, "we have enough" stop, "switch to food" mid-gather, P0 zombie mid-gather, baseline no-interrupt) deferred to developer | 2026-05-13 | 0744c6e+0bee0d0 |   | [260513-wkd-orchestrator-loop-fsm-rework-convert-blo](./quick/260513-wkd-orchestrator-loop-fsm-rework-convert-blo/) |
| 260514-ngj | P1/P0 interrupt response semantics rework. Replaces 260513-wkd's broken case-1/2/3 dispatcher (which silently swapped case-1 from "keep going" to "terminal" and re-enqueued triggers with `null` data → message-spam loops) with the originally-locked R1/R2/R3/R4 model. R1 (text only, default) keeps in-flight and loop alive on P0/P1-triggered iterations; R2 (text + new action) aborts old, new becomes in-flight, SAME loop; R3 (text + `end_loop`) aborts + terminates; R4 (text + `end_loop` + new action) terminates and reseeds a fresh loop with the original `_triggerData`. P2/P3-triggered iterations unchanged — text-only still terminates naturally. New `end_loop` inline-metadata tool replaces retired `stop`. Owner chat no longer pre-aborts the in-flight body (`forceCancelBody` removed from non-stop-verb path in `behaviors/chat.js`); the action runs until the model explicitly decides. First spawn enqueues `sei:idle` (P3) instead of `sei:joined` (P1); `sei:joined` dropped from `triggerIsP0P1`. `loop._triggerData` now populated at creation (was the unset field causing the `null`-data reseed bug). Persona addendum injected only on P0/P1 iterations. Harness `scripts/verify-260514-gam.mjs` extended to 14/14 (G1..G8 + R1..R4 + R-spawn-idle); `scripts/verify-260513-wkd.mjs` regression guard still 13/13. Live in-game verification (cactus scatter + interrupt, "stop and come here," idle-spawn greeting) deferred to developer | 2026-05-14 | fa8ac5d+752fd3c+65be3a7 |   | [260514-ngj-implement-p1-p0-interrupt-response-seman](./quick/260514-ngj-implement-p1-p0-interrupt-response-seman/) |
| 260516-x62 | Ship 3 default personas (Sui — chaotic young AI; Mochineko — catgirl maid that follows by default; Clawd — Marvin-style paranoid android) with pre-baked `persona.expanded` so first launch burns no Anthropic call. Seeded into `<userData>/characters/` via persistent `defaults-seeded.json` tracker so user deletions stick. `CharacterCard` DEFAULT chip keyed off `is_default` flag (was hardcoded `id === 'sui'`). `listCharacters` self-heals legacy `persona_prompt`/`description` files (unlink + drop from index + log warn once) instead of nagging forever. Bundled `personaExpansion.ts` validation fix: per-section regex tolerant to `#` vs `##`, casing, em-dash vs hyphen, dropped em-dash from the `# MEMORY` header the model routinely failed to emit, error messages now name missing sections + dump model output for debugging — fixes the chars.save IPC error blocking all character creation. User's three legacy on-disk character files (sui/testbot/eris) deleted as one-off; reset index.json so next boot starts clean and reseeds the new defaults | 2026-05-17 | 8a76e0f | Needs Review | [260516-x62-ship-3-default-personas-sui-mochineko-cl](./quick/260516-x62-ship-3-default-personas-sui-mochineko-cl/) |
| 260517-frz | Bot custom skins in offline play — promoted to Phase 9 (CustomSkinLoader). Research + discussion preserved at `.planning/phases/09-.../RESEARCH.md` and CONTEXT.md. Ruled out 4 alternatives: signed-texture injection (vanilla strips properties), prismarine-proxy (host bypasses TCP via LocalChannel), Paper sidecar (heavy + Pixelmon-incompatible), paid Mojang account (still hits offline-mode stripping). | 2026-05-17 | (pending) | Promoted → Phase 9 | [260517-frz-research-and-implement-giving-bots-custo](./quick/260517-frz-research-and-implement-giving-bots-custo/) |
| 260516-0yw | Persona expansion + action tick + baseline trim + first-person memory. (1) Character creation now runs a one-time main-process Anthropic call (Haiku 4.5, 30s timeout) that expands user's short persona blurb into a structured prompt (IDENTITY / VOICE / DYNAMIC / PROACTIVENESS / REACTIONS / MEMORY). Edit regenerates with prior expansion as voice-continuity reference. Renderer shows collapsible expanded-prompt preview; legacy `description` field removed outright (no backwards-compat shim). (2) `follow` becomes open-ended — handler blocks on AbortSignal and resolves only on abort. Any in-flight action firing for >10s triggers `sei:action_tick` at LOCKED `Priority.P2_ACTION_TICK = 2.3` (between P2_ACTION_COMPLETE=2.1 and P2_5_LOOP_END=2.5); dispatcher classifier renamed `iterationTriggerIsP0P1` → `iterationKeepsLoopAlive` and extended so tick text-only iterations don't tear down the loop. `clearActionTick` helper paired with all 5 inner-abort sites using the correct loop variable in scope (`currentLoop`/`dyingLoop`/`loop`) plus both settle-handler arms; outer-loop aborts left bare (rely on in-flight settle). (3) `BASELINE_INSTRUCTIONS` trimmed to mechanics only (length cap / in-game-chat semantics / anti-prompt-injection identity guardrails / tool + end_loop + action-tick mechanics); voice / tone / proactiveness / reactions moved into the expanded persona template. (4) `remember()` description steers first-person colored entries from the bot's own perspective; `compactor.js` system prompt explicitly preserves the emotional arc across compactions so long-time relationship development (e.g. Eris-style tsun→dere arc) survives memory condensation. Three new test scripts (test-actionTick.mjs 7/7, test-followOpenEnded.mjs PASS, test-personaExpansion.mjs 6/6) plus end-to-end signal-plumbing assertion guard against `_buildExecOpts` regression. `npx tsc --noEmit` clean on both tsconfigs. Live verification required for: Electron 2-step add-character flow with real Anthropic call, edit-regenerate voice continuity, 10s tick cadence in live Minecraft world, follow-spam-loop disappearance | 2026-05-16 | 619b8e6+5030ac7+bb6490c | Needs Review | [260516-0yw-persona-expansion-action-tick-baseline-t](./quick/260516-0yw-persona-expansion-action-tick-baseline-t/) |
| Phase 06 P01 | 118 | 2 tasks | 2 files |

## Session Continuity

- **Last action:** Phase 9 Plan 01 executed (Wave 1: shared contracts for skin + setup-wizard pipeline). Extended CharacterSchema with `skin: SkinSchema` (zod enum source: bundled|upload|username|none) + per-persona `username: string|null` (MC regex + 16-char cap). Added 7 ErrorClass entries (MOD_DOWNLOAD_FAILED / FABRIC_INSTALL_FAILED / MC_INSTALL_NOT_FOUND / MOJANG_LOOKUP_FAILED / SKIN_FILE_INVALID / SKIN_SERVER_PORT_TAKEN / WIZARD_PERMISSION_DENIED) with verbatim ERROR_COPY from 09-UI-SPEC. IpcChannel.skin (5 channels) + IpcChannel.wizard (5 channels incl. wizard:cancel for IPC-crossing aborts + wizard:progress push channel). RendererApi gains 10 new methods; applySkin signature takes optional `username` for atomic two-field updates; runWizardInstall takes sessionId paired with wizardCancel(sessionId). Three bundled 64x64 RGBA PNG default skins (sui/mochineko/clawd, 220-222 bytes each) generated by hand-rolled `scripts/build-default-skins.mjs` (Node stdlib only — no sharp/pngjs runtime dep). All three default character JSONs seed `skin: bundled` + `username` matching persona name. electron-builder.yml asarUnpack extended with `resources/skins/**/*`. Both tsconfigs typecheck clean. Commits: `036457b` (Task 1 — shared contracts), `f522d4d` (Task 2 — bundled PNGs + JSON seeds + asarUnpack).
- **Next action:** Plan 09-02 (per-persona skin store + applySkin/removeSkin/uploadSkinPng/searchMojangSkin handlers in main process) — Plan 01 contracts now locked, downstream waves can grow `src/main/*` and `src/renderer/*` without re-touching `src/shared/*`.
- **Performance:** Plan 09-01 — duration ~25min, 2 tasks, 15 files (4 created + 11 modified), 0 deviations beyond a single Rule 3 auto-fix (5-line literal extension in src/main/migration.ts + AddCharacterScreen.tsx to satisfy strict types after adding default-bearing fields to CharacterSchema).

---
*Last updated: 2026-05-17 — Phase 8 Plan 01 (static audit + appId lock) complete. electron-builder.yml `appId: com.sei.app` LOCKED; 08-HOTSPOTS.md seeds Wave 2/3 verification checklist. Next: Plan 02 (Windows dev smoke) requires a Windows VM.*
| 2026-05-03 | fast | attack pursues + zod entity schema cleanup | done |
| 2026-05-05 | fast | docs cleanup: remove two-layer/ollama from README+ARCHITECTURE | done |
| 2026-05-05 | fast | drop port from persisted config; LAN discovery is the only path | done |
