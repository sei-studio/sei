# Roadmap: Sei

**Created:** 2026-04-24
**Granularity:** coarse (4 phases)
**Core Value:** A Minecraft companion that feels like a real character — it remembers you, reacts to the world, and acts with personality, not like a scripted bot.

## Phases

- [x] **Phase 1: Bot Substrate** - Mineflayer connection, action registry, FSM, and scripted reflex behavior (no LLMs yet)
- [x] **Phase 2: Two-Layer LLM Loop** - Personality LLM (Haiku 3) + movement LLM (Ollama Qwen) wired into the FSM with guardrails
- [x] **Phase 2.1: Expand Actions & Game State (INSERTED)** - Broaden Zod action registry beyond goTo/setGoals and surface inventory/surroundings/position to the personality LLM as text so Sei can actually play
- [x] **Phase 3: Memory & Persistence** - Active-loop architecture (Loop owns canonical messages, single-flight gating, abort-and-resume, 20-iter cap), markdown OWNER.md + DIARY.md memory layer with seed-loader, and LLM-directed compaction (per-Loop summary + async session-end consolidation, both reusing cached system blocks). MEM-05 SQLite deferred to V2.
- [x] **Phase 4: Electron GUI & Packaging** - Setup form, Start/Stop, live log viewer, and bundled .dmg/.exe distribution
- [x] **Phase 5: Debug log readability (PROMOTED from 999.2)** - Event-per-line emission with explicit \n between [haiku?] / [haiku!] / [chat->] sections; cache-prefix elision via hash reference
- [x] **Phase 6: Scavenging redesign (PROMOTED from 999.1)** - Veined tallying within chunk, smart_find for cross-chunk navigation, find() for NL-to-item resolution
- [x] **Phase 7: Pillar-up / scaffolding behavior (PROMOTED from 999.3)** - placeBlock/equip wiring + pillarUp orchestrator so bot can reach elevated targets
- [ ] **Phase 8: Windows cross-platform compatibility** - Verify and fix Sei to run on Windows (precondition for Phase 9 wizard)
- [ ] **Phase 9: Custom bot skins via CustomSkinLoader** - Setup wizard auto-installs Fabric Loader + CustomSkinLoader; user uploads/searches skin with 3D preview; bot joins LAN world wearing chosen skin under chosen username

## Phase Details

### Phase 1: Bot Substrate
**Goal**: A mineflayer-driven Minecraft bot connects to a server, executes scripted reflex behavior, and exposes a closed, Zod-typed action registry through an event-sourced FSM — all without any LLM involvement.
**Depends on**: Nothing (foundation)
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-04, BOT-01, BOT-02, BOT-03, BOT-04, BOT-05, BOT-06
**Success Criteria** (what must be TRUE):
  1. A developer can launch the bot with a server IP/port and Microsoft account, and see it join the server with auto-detected version.
  2. When disconnected, the bot automatically reconnects and surfaces connection errors as plain-English status messages.
  3. The bot follows its owner, responds to proximity/addressed chat, auto-eats when hungry, and defends itself when attacked — entirely through scripted handlers, no LLM.
  4. Every pathfinder call has a wall-clock timeout and returns "couldn't reach" as a first-class result rather than hanging.
  5. An event queue + FSM skeleton routes chat, world, and movement-completion events through a single orchestrator ready to be driven by an LLM in Phase 2.
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffold, config schema, bot connection + reconnect loop
- [x] 01-02-PLAN.md — Pathfinder wrapper, action registry, reflex behaviors (follow/chat/eat/combat)
- [x] 01-03-PLAN.md — Event-sourced FSM with priority queue, AbortController, behavior wiring

### Phase 2: Two-Layer LLM Loop
**Goal**: The personality LLM drives the bot via natural-language hand-off to a local movement LLM that calls actions from the registry, with hard guardrails preventing runaway loops or cost.
**Depends on**: Phase 1
**Requirements**: LLM-01, LLM-02, LLM-03, LLM-04, LLM-05, LLM-06, LLM-07, LLM-08, PERS-01, PERS-02, PERS-03, PERS-04, PERS-05
**Success Criteria** (what must be TRUE):
  1. The personality LLM (Haiku 3) reacts to chat, world events, and 10s idle fallback, and hands off natural-language intent to the movement LLM (never coordinates or code).
  2. The movement LLM (Ollama Qwen 2.5) reliably calls registered actions from the Zod-typed registry, and the system falls back to Haiku-as-executor when Ollama is unavailable.
  3. A recursion cap (5 hops), event debounce (500ms), rate limit (30/min), and AbortController-based action cancellation demonstrably prevent runaway loops under stress.
  4. The bot speaks in a configurable name/backstory/tone that is stable across sessions and forms the cached Anthropic prompt prefix.
  5. When idle near its owner, the bot makes rate-limited proactive observations that feel in-character, not scripted.
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — Config schema, persona renderer, Zod->JSON Schema bridge, Anthropic + Ollama clients
- [x] 02-02-PLAN.md — Goal store, rate limiter, debouncer, circuit breaker, setGoals action, orchestrator
- [x] 02-03-PLAN.md — Wire orchestrator into FSM + ingestion debounce + verification harness

### Phase 2.1: Expand Actions & Game State (INSERTED)
**Goal**: The personality LLM has a text-rendered view of the bot's local world (position, surroundings, inventory) and a high-level summary of what the movement LLM can actually do, while the movement LLM gains a broader Zod-typed action registry so Sei can carry out planned goals beyond `goTo` and `setGoals`.
**Depends on**: Phase 2
**Status**: Urgent insertion — discovered after Phase 2 that current action surface is too narrow for Sei to "play" the game.
**Scope notes**:
  - Add game state observers (inventory, nearby blocks/entities, biome, time of day, position) and render compact text snapshots into the personality LLM context.
  - Expand the closed Zod action registry with the next tier of mineflayer primitives (e.g. dig/place/equip/attack/look/jump/eat — final list TBD in plan phase). All new actions must keep the registry closed and timeout-wrapped per project rules.
  - Provide the personality LLM a short capability overview (not function schemas) so it stops requesting impossible behavior ("do a backflip"). Lean on Haiku's existing Minecraft knowledge.
  - Keep the two-layer hand-off contract intact: personality emits natural-language intent, movement LLM picks actions.
**Success Criteria** (what must be TRUE):
  1. Personality LLM responses reference current inventory, position, and immediate surroundings when relevant, sourced from text observations injected into context.
  2. Movement LLM can execute basic gameplay tasks (gather, place, eat, equip, attack) via the action registry, not just navigation.
  3. Personality LLM avoids requesting capabilities outside the registry's intent — verified with a small adversarial prompt set.
  4. All new actions are timeout-wrapped, AbortController-cancellable, and respect the existing FSM priority queue.
  5. No regression in Phase 2 guardrails (recursion cap, debounce, rate limit, circuit breaker).
**Plans**: 3 plans

Plans:
- [x] 2.1-01-PLAN.md — Observers, snapshot composer, targeting resolver, cached-prefix extension (capability/primer/learning)
- [x] 2.1-02-PLAN.md — 12 tier-1 action handlers (dig/place/equip/attack/consume/lookAt/drop/activate/sleep + container trio) registered in createDefaultRegistry
- [x] 2.1-03-PLAN.md — Wire snapshot+cached-prefix+look()+container cleanup into orchestrator; adversarial verification harness
**Conflict review**: Checked against Phase 3 (Memory) and Phase 4 (GUI). No conflict — Phase 3 still owns SQLite persistence and LLM-directed compaction; this phase only adds in-context observations. Phase 4 unaffected.

### Phase 3: Memory & Persistence
**Goal**: The bot remembers its identity, owner, and world progression across restarts via OWNER.md + DIARY.md (markdown files; SQLite deferred to V2), with compaction timing decided by the personality LLM at Loop-terminal / session-terminal semantic boundaries.
**Depends on**: Phase 2
**Requirements**: MEM-01, MEM-02, MEM-03, MEM-04, MEM-05
**Success Criteria** (what must be TRUE):
  1. Recent events and chat accumulate in a Loop-owned messages array across iterations until the Loop reaches its terminal response.
  2. After a restart, the bot recognizes its owner by player UUID and references prior shared history (OWNER.md + DIARY.md) in conversation.
  3. Per-loop-batch summaries fire on Loop-terminal under a 10-loops-or-32-KB gate; consolidation fires on session-end (or size-pressure async) under a 4-sessions-or-200-KB gate. The 10s idle probe never compacts.
  4. Long-term memory (DIARY.md) records world progression (builds, exploration, accomplishments) and is loaded into every Loops seed user turn (recency-truncated).
  5. Markdown files (OWNER.md + DIARY.md) use atomic tmp+rename writes and a 200 KB soft size cap with consolidation — files do not grow unbounded under long play sessions.
**Plans**: 3 plans

Plans:
- [ ] 3-01-active-loop-architecture-PLAN.md — Loop class, idle/active gating, interrupt-on-chat with messages preservation, 20-iteration cap, chains.js no-op shim, SPEC vocabulary update
- [ ] 3-02-markdown-memory-layer-PLAN.md — atomicWrite, OWNER.md, DIARY.md, sessionState, owner UUID detection (D-48), seed-message loader (D-45)
- [ ] 3-03-compaction-calls-PLAN.md — per-loop-batch summary (D-51), async consolidation (D-53), prompts (D-52, D-54), phase-level verification harness

### Phase 03.1: Behavior polish and AI/game decoupling refactor (analysis-driven from logs/) (INSERTED)

**Goal:** Achieve more natural in-game behavior via small modifications and codebase refactoring: (1) fix ~37 cataloged defects from 4 in-game logs (logs/explore.txt, hunt+sand.txt, memory.txt, wood.txt); (2) establish a brain/ (game-agnostic) vs adapter/minecraft/ (game-specific) seam so the bot brain could later drive a different game library; (3) reduce Haiku token usage where free wins exist (cache-respecting); (4) make memory recall feel like a long-time friend (fix the structural diary write-side bug where pure-chat sessions never produce diary entries).
**Requirements**: None — this phase is quality/polish work, not new requirements coverage. Bounded by D-1 through D-8 in 03.1-CONTEXT.md plus the 37 defects in log-analysis/.
**Depends on:** Phase 3
**Plans:** 10/10 plans complete

Plans:
- [x] 03.1-01-PLAN.md — brain/ vs adapter/minecraft/ file moves + Adapter JSDoc contract (Wave 1)
- [x] 03.1-02-PLAN.md — bot.js / fsm.js / config.js border splits, primer move, orchestrator adapter-ization (Wave 1)
- [x] 03.1-03-PLAN.md — persona we-framing + SYSTEM_INSTRUCTIONS dedup + first-turn-say strengthening + punctuation post-processor + loopHistory cap (Wave 2)
- [x] 03.1-04-PLAN.md — noteToSelf tool + AFFECT.md + OWNER.md write helpers + diary OR-gate + compaction prompt rewrite (Wave 2)
- [x] 03.1-05-PLAN.md — first-turn-say hard enforcement + parallel-dig cap=1 + follow/attackEntity no-op + pathfind hints + idle/loop_end split + dropItem-paired-say + interrupt dedup (Wave 3)
- [x] 03.1-06-PLAN.md — VALIDATION.md (37 defects + refactor invariants) + STATE.md/ROADMAP.md status updates (Wave 4, has checkpoint for live replay)
- [x] 03.1-07-PLAN.md — Tone & say polish gap-closure: postProcessSay regex refined (D-NEW-TONE-1), shouldSuppressLoopEndSay predicate + dedupe wiring (D-NEW-DM-1/2/3), model-authored cap-close (D-W-8 / D-NEW-TONE-2)
- [x] 03.1-08-PLAN.md — Bucket A continuation (gap-closure)
- [x] 03.1-09-PLAN.md — Bucket A continuation (gap-closure: NEW-W-A, D-H-15, D-H-16, D-W-7, WR-07)
- [x] 03.1-10-PLAN.md — Bucket A continuation (gap-closure: WR-01 FSM re-queue stall, WR-02 abortController re-bridge, WR-04 attack/interrupt preservation, WR-08 narrowed affect-log catch)

### Phase 4: Electron GUI & Packaging
**Goal**: A non-technical user can double-click an installer, fill in a setup form, and press Start to run Sei — with all errors explained in plain English and native modules working in the packaged build.
**Depends on**: Phase 3
**Requirements**: GUI-01, GUI-02, GUI-03, GUI-04, GUI-05, PKG-01, PKG-02, PKG-03
**Success Criteria** (what must be TRUE):
  1. A non-technical user completes setup (server IP/port, API key stored via OS keychain, personality name/backstory/tone) in the Electron GUI without editing any files.
  2. Start/Stop controls a utilityProcess-hosted bot, and a live log viewer streams bot activity, LLM decisions, and errors in real time.
  3. Every user-facing error includes a plain-English explanation and an action hint ("Check your server address", "Start Ollama", etc.).
  4. `electron-builder` produces a signed .dmg (macOS) and .exe installer (Windows) with better-sqlite3 rebuilt for the bundled Electron ABI via `@electron/rebuild`.
  5. Packaged builds are validated on clean VMs with no dev environment before release.
**Plans**: 11 plans

Plans:
- [x] 04-01-build-scaffold-PLAN.md — electron-vite + electron-builder + relocate src/{brain,adapter,cli,registry,config,index} → src/bot/, logo assets relocate, stub electron-builder.yml
- [x] 04-02-shared-types-PLAN.md — src/shared/{ipc.ts, characterSchema.ts, errorClasses.ts} (RendererApi + Zod schemas + ErrorClass union)
- [x] 04-03-stores-and-secrets-PLAN.md — main/{paths, configStore, characterStore, apiKeyStore (safeStorage), migration} with atomicWrite reuse
- [x] 04-04-bot-supervisor-PLAN.md — main/{lanWatcher, botSupervisor, logRouter} + augment src/bot/index.js for parentPort handshake
- [x] 04-05-main-entry-and-ipc-PLAN.md — main/{windowChrome, ipc, index} composer + preload contextBridge
- [x] 04-06-renderer-shell-PLAN.md — Vite/React entry, tokens/global/animations/fonts CSS, Zustand stores, primitive components, LoadingScreen
- [x] 04-07-onboarding-and-home-PLAN.md — OnboardingScreen + HomeScreen + AddCharacterScreen + ComingSoonScreen + grid components
- [x] 04-08-character-page-and-modals-PLAN.md — CharacterPage + SettingsScreen + LanModal + SummonToast + DeleteConfirmModal + LogsPanel
- [x] 04-09-error-mapping-PLAN.md — lib/errors.ts ERROR_COPY map + Banner + classifyChildError in botSupervisor
- [x] 04-10-packaging-PLAN.md — electron-builder.yml flesh-out + entitlements.mac.plist + npm run build smoke + [BLOCKING] lock-identifiers task
- [x] 04-11-clean-vm-validation-PLAN.md — clean-VM smoke on macOS/Windows/Linux + RELEASE-NOTES.md

### Phase 5: Debug log human readability (event-per-line) (PROMOTED from 999.2)

**Goal:** Switch debug logger from line-tee (single physical lines wrapping 8000–11000 chars) to event-per-line emission with explicit `\n` between `[haiku?]` / `[haiku!]` / `[chat->]` sections. Elide repeated cache-prefix JSON in `[haiku?]` events via hash reference (e.g., `<diary @sha=...>`) after first appearance per session.
**Source defects:** D-NEW-LOG-1, D-NEW-LOG-2 (`.planning/phases/03.1-.../VALIDATION.md` L184-185)
**Why first:** Required so Phases 6/7 (scavenging, scaffolding) work can be debugged from logs at all — the lightest of the three promoted backlog items.
**Depends on:** Phase 03.1
**Requirements:** TBD
**Plans:** 4 plans

Plans:
- [ ] 05-01-PLAN.md — log.js multi-line emit + per-event section renderers + session hash dictionary (persona/capability/diary elision) + anthropicClient namedUserBlocks param
- [ ] 05-02-PLAN.md — orchestrator passes loop._internal.messages as namedUserBlocks to both anthropic.call sites (API payload unchanged)
- [ ] 05-03-PLAN.md — logRouter.ts multi-line state machine (SENTINEL_RE + open-event buffer + [truncated] recovery on dropped end)
- [ ] 05-04-PLAN.md — scripts/verify-phase5.mjs end-to-end harness + developer-driven live-bot log inspection checkpoint

### Phase 6: Scavenging redesign — veined tallying + smart_find + find() (PROMOTED from 999.1, MILESTONE-SCOPE)

**Goal:** Replace the snapshot composer's "16 nearest blocks by distance" world-state with a veined representation: per visible block-type, show the nearest representative + connected vein count + total visible types. Add a `smart_find` cross-chunk navigation primitive for when nothing is visible locally, and a `find()` action that maps natural-language item names ("wood", "iron") to concrete game IDs ("oak_log", "iron_ore") so the model can plan multi-step gathering.
**Source defects:** D-NEW-SCAV-1, D-NEW-SCAV-2, D-NEW-SCAV-3 (`.planning/phases/03.1-.../VALIDATION.md` L138-139, L191-193)
**User quote (verbatim):** *"combine veined tallying for within chunk and smart_find for navigating to other chunks, i think we finally can make scavenging resources work."*
**Scope warning:** Snapshot composer rewrite + new tool registration + closed-world NL→item resolver — three coupled subsystems. Recommend `/gsd-discuss-phase 6` first to scope each before planning.
**Depends on:** Phase 5 (readable logs needed for verification)
**Requirements:** D-NEW-SCAV-1, D-NEW-SCAV-2, D-NEW-SCAV-3 (scope collapsed during /gsd-discuss-phase 6 — original smart_find merged into find(); mine_vein added)
**Plans:** 4 plans

Plans:
- [x] 06-01-veins-observer-PLAN.md — nearbyVeins flood-fill scanner (observers/veins.js) + unit test
- [ ] 06-02-loose-terms-PLAN.md — hand-curated NL→ID table + resolveTerm helper (loose-terms.js) + unit test
- [ ] 06-03-mine-vein-behavior-PLAN.md — mineVeinAction + MINE_VEIN_DESCRIPTION (behaviors/mineVein.js) + unit test
- [ ] 06-04-integrate-and-verify-PLAN.md — snapshot integration + register find/mine_vein + ACTION_DESCRIPTIONS update + verify-phase6.mjs + live-bot checkpoint

### Phase 7: Pillar-up / scaffolding behavior (PROMOTED from 999.3)

**Goal:** Implement bot self-place / pillar-up so it can reach elevated targets (trees, ores up a slope, escape pits). User reports the bot "tried to place dirt block under it" but logs show zero `placeBlock(` and zero `equip(` calls — the action surface doesn't exist yet.
**Source defects:** NEW-W-C (`.planning/phases/03.1-.../VALIDATION.md` L214)
**Touch points:** `DIG_DESCRIPTION` (so model knows the affordance exists), `placeBlock` action, `equip` action, possibly a `pillarUp(target_y)` action that orchestrates both. Mineflayer has primitives — wiring is what's missing.
**Depends on:** Phase 6 (find() / smart_find provide block-id resolution this phase needs for "what to place")
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (run `/gsd-plan-phase 7` to break down)

## Backlog

Items deferred from Phase 03.1 live replay (Bucket B per `.planning/phases/03.1-.../03.1-VERIFICATION.md`).
Each is unsequenced — promote to active milestone via `/gsd-review-backlog` when ready.

### Phase 999.1: Scavenging redesign — veined tallying + smart_find + find() (PROMOTED → Phase 6)

**Goal:** Replace the snapshot composer's "16 nearest blocks by distance" world-state with a veined representation: per visible block-type, show the nearest representative + connected vein count + total visible types. Add a `smart_find` cross-chunk navigation primitive for when nothing is visible locally, and a `find()` action that maps natural-language item names ("wood", "iron") to concrete game IDs ("oak_log", "iron_ore") so the model can plan multi-step gathering.
**Source defects:** D-NEW-SCAV-1, D-NEW-SCAV-2, D-NEW-SCAV-3 (`.planning/phases/03.1-.../VALIDATION.md` L138-139, L191-193)
**User quote (verbatim):** *"combine veined tallying for within chunk and smart_find for navigating to other chunks, i think we finally can make scavenging resources work."*
**Why milestone-scope:** Snapshot composer rewrite + new tool registration + closed-world NL→item resolver — three coupled systems, not a single phase.
**Requirements:** TBD
**Plans:** 4/8 plans executed

Plans:
- [x] TBD (recommended: `/gsd-new-milestone` after Phase 03.1 ships, then `/gsd-discuss-phase` to scope each subsystem) (completed 2026-05-07)

### Phase 999.2: Debug log human readability (PROMOTED → Phase 5)

**Goal:** Switch debug logger from line-tee (single physical lines wrapping 8000-11000 chars) to event-per-line emission with explicit `\n` between `[haiku?]` / `[haiku!]` / `[chat->]` sections. Elide repeated cache-prefix JSON in `[haiku?]` events via hash reference (e.g., `<diary @sha=...>`) after first appearance per session.
**Source defects:** D-NEW-LOG-1, D-NEW-LOG-2 (`.planning/phases/03.1-.../VALIDATION.md` L184-185)
**Why deferred:** Touches the logger format used everywhere — needs an upfront design decision on canonical event-record shape before refactoring.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (recommended: `/gsd-discuss-phase 999.2` to lock event-record schema first)

### Phase 999.3: Pillar-up / scaffolding behavior (PROMOTED → Phase 7)

**Goal:** Implement bot self-place / pillar-up so it can reach elevated targets (trees, ores up a slope, escape pits). User reports the bot "tried to place dirt block under it" but logs show zero `placeBlock(` and zero `equip(` calls — the action surface doesn't exist yet.
**Source defects:** NEW-W-C (`.planning/phases/03.1-.../VALIDATION.md` L214)
**Touch points:** DIG_DESCRIPTION (so model knows the affordance exists), `placeBlock` action, `equip` action, possibly an action like `pillarUp(target_y)` that orchestrates both. Mineflayer has primitives — wiring is what's missing.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (recommended: standalone phase after Phase 03.1 gap-closure ships)

### Phase 999.4: noteToSelf activation strategy — push vs pull (BACKLOG)

**Goal:** Strengthen noteToSelf so the model fires it consistently in non-explicit-memory scenarios (currently only fires when user explicitly says "remember this"). Decide between push (LLM-decides via stronger prompt cue + few-shot examples) or pull (rule-based extractor that scans tool_use turns for memory-worthy facts and prompts noteToSelf as a follow-up).
**Source defects:** D-NEW-MEM-1 (`.planning/phases/03.1-.../03.1-VERIFICATION.md` L103)
**Why deferred:** Plumbing already works (Plan 03.1-04 shipped it) — this is a behavior-tuning design decision, not a bug fix.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (recommended: `/gsd-discuss-phase 999.4` to pick push vs pull before planning)

### Phase 999.5: Disconnect-on-attacked regression (BACKLOG, HIGH)

**Goal:** Investigate and fix the regression where Sei disconnects from the server when attacked. User explicitly flagged this as a previously-fixed bug that has reappeared.
**Source defects:** D-H-12 (`.planning/phases/03.1-.../03.1-VERIFICATION.md` L105; reproduction at `logs/hunt+sand-postfix.txt` lines 104, 179)
**User quote:** *"keeps disconnecting when attacked, this is an old issue we've fixed"*
**First step:** `git bisect` against last-known-good commit before scoping the fix — root cause unknown. Could be a regression in mineflayer-pvp wiring, abort-controller leakage into bot connection, or auto-eat / pathfinder interference under attack signal.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (recommended: bisect first, then `/gsd-plan-phase 999.5` once root cause is known)

### Phase 999.6: First-turn-say architecture (BACKLOG)

**Goal:** Replace the current post-hoc abort+retry first-turn-say enforcement with a structural fix. Two candidates: (a) prefill the assistant turn so the model is forced to begin with a `say` tool_use, or (b) keep the abort+retry but harden it so memory-only turns and other legit non-say turns aren't penalized.
**Source defects:** D-H-14 (`.planning/phases/03.1-.../03.1-VERIFICATION.md` L107)
**Why deferred:** Either approach is structural — needs a discuss-phase to weigh prefill cache implications vs. abort+retry iteration cost.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (recommended: `/gsd-discuss-phase 999.6` to pick prefill vs hardened-retry)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Bot Substrate | 3/3 | Complete | 2026-04-24 |
| 2. Two-Layer LLM Loop | 3/3 | Complete | 2026-04-25 |
| 2.1. Expand Actions & Game State | 3/3 | Complete | 2026-04-25 |
| 3. Memory & Persistence | 0/0 | Not started | - |
| 4. Electron GUI & Packaging | 0/0 | Not started | - |
| 5. Debug log readability (from 999.2) | 0/0 | Not started | - |
| 6. Scavenging redesign (from 999.1) | 0/0 | Not started | - |
| 7. Pillar-up scaffolding (from 999.3) | 0/0 | Not started | - |

## Coverage

- v1 requirements: 36 total
- Mapped: 36 / 36
- Orphans: 0

### Phase 8: Windows cross-platform compatibility

**Goal:** Verify and fix Sei to run on Windows. Currently only tested on macOS. Precondition for the custom-skin wizard (Phase 9), which depends on cross-platform path handling, OS-specific install detection, and JAR-exec patterns.
**Requirements**: TBD
**Depends on:** Phase 7
**Plans:** 4 plans

Plans:
- [x] 08-01-static-audit-and-appid-lock-PLAN.md — Static audit of every cross-platform-sensitive file (08-HOTSPOTS.md, 24 rows) + lock electron-builder.yml appId to com.sei.app (closes Phase 4 04-10 BLOCKING)
- [ ] 08-02-windows-dev-smoke-PLAN.md — USER runs npm install + npm run dev on Windows 10/11 x64; produces 08-DEV-SMOKE.md + seeds 08-WINDOWS-DEFECTS.md
- [ ] 08-03-windows-packaged-smoke-and-defect-fix-PLAN.md — USER runs npm run dist:win + installs NSIS .exe on clean Windows profile; executor ships atomic fix(08-win): commits for OPEN defects until all 6 Bars PASS
- [ ] 08-04-documentation-PLAN.md — README Windows section + RELEASE-NOTES Windows entry + 08-WINDOWS-GUIDE.md canonical reference (autonomous, no live Windows needed)

### Phase 9: Custom bot skins via CustomSkinLoader

**Goal:** Bot's custom skin and username are visible to the host in their own LAN world, with zero manual config beyond clicking through Sei's first-launch wizard. User workflow: download Sei → setup wizard auto-installs Fabric Loader + CustomSkinLoader into their MC profile (mac & windows) → upload or search a skin in Sei's character page → preview in 3D → on next MC launch select the new "Sei (Fabric Loader)" profile → bot joins their world wearing the chosen skin under any chosen username. Works on vanilla MC and CurseForge instances (Pixelmon etc.).
**Requirements**: TBD
**Depends on:** Phase 8
**Plans:** 5/8 plans executed

Plans:
- [x] 09-01-PLAN.md — Shared contracts: CharacterSchema skin+username, IpcChannel.skin/wizard (incl. wizard:cancel + applySkin.username), 7 new ErrorClass entries, 3 bundled default skin PNGs
- [x] 09-02-PLAN.md — Local 127.0.0.1 skin HTTP server + per-persona PNG storage + bot init wiring; characterId validated via strict IdSchema (BLOCKER 1); atomic skin+username write in single saveCharacter call (WARNING 5)
- [x] 09-03-PLAN.md — Mojang username search pipeline (15s timeout) + legacy 64×32 → 64×64 normalization (WARNING 8) + native PNG file dialog + 2 new skin IPC handlers + tsx as devDep (INFO 9)
- [x] 09-04-PLAN.md — Wizard backend modules: cross-platform MC install scanner + bundled-Java probe (BLOCKER 3) + Fabric installer + CustomSkinLoader downloader + config writer with verified CustomSkinAPI loader type (WARNING 6) + idempotent state store
- [ ] 09-05-PLAN.md — Wizard orchestrator + IPC handlers (install + cancel via sessionId Map per BLOCKER 2) + main bootstrap port-drift detection (WARNING 7) + 2 verification scripts (split from prior Plan 04 per WARNING 4)
- [x] 09-06-PLAN.md — Skin editor UI on CharacterPage: SkinEditor + SkinPreview3d (lazy skinview3d) + SkinUploadZone + UsernameSearchField + StatusPill; single applySkin call writes skin+username atomically (WARNING 5); preview useEffect deps include character.username (INFO 10)
- [ ] 09-07-PLAN.md — Setup wizard UI: SetupWizardModal (5 steps + 2 branches) + WizardStepShell + McInstallList/Row + InstallProgressList + Settings row + first-launch trigger; cancel button fires sei.wizardCancel(sessionId) — no renderer-local AbortController (BLOCKER 2)
- [ ] 09-08-PLAN.md — Master verify:phase9 harness + README/RELEASE-NOTES docs (incl. bundled-Java + CustomSkinAPI mentions) + 09-VERIFICATION.md goal-backward audit covering all BLOCKER/WARNING/INFO issues

**References:**
- `.planning/phases/09-.../260517-frz-CONTEXT.md` — locked decisions from discussion phase
- `.planning/phases/09-.../260517-frz-RESEARCH.md` — full research (vanilla LAN constraints, alternative approaches considered, why CustomSkinLoader won over proxy/Paper/flying-squid)

---
*Last updated: 2026-05-07 — Phases 5/6/7 promoted from backlog 999.2 / 999.1 / 999.3 (debug log readability + scavenging redesign + pillar-up scaffolding).*
