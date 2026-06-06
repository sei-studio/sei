---
quick_id: 260508-nkk
phase: quick
mode: quick
tags: [electron, gui, bug-fix, summon, mineflayer, hang-diagnosis, ui-polish]
key-files:
  modified:
    - src/renderer/src/screens/CharacterPage.tsx
    - src/renderer/src/screens/CharacterPage.module.css
    - src/bot/index.js
    - src/bot/adapter/minecraft/connect.js
    - src/main/botSupervisor.ts
decisions:
  - In dev mode the executor has no display server and no Minecraft instance, so Task B's root cause was identified by static analysis only — no live repro was performed. The diagnosis is supported by file inspection + a runtime probe of createDiary() that confirmed the synchronous throw path.
  - Task A renders the same deterministic PixelPortrait twice (once full-bleed at size=1600 behind .crumb/.cols, once boxed inside .portraitCard at size=320). generatePixelGrid is memoized on (seed, palette) so double-render is essentially free at the grid-compute level; only the canvas paint runs twice.
  - Task B moves the summon-ready emit into mineflayer's actual 'spawn' event (NOT start()'s return). Previously summon-ready meant "brain wired up," not "bot in the world" — any post-wire mineflayer stall produced indefinite "Connecting…".
  - Connect timeout set to 20s (CONNECT_TIMEOUT_MS = 20_000) — comfortably below the supervisor's 30s SUMMON_TIMEOUT_MS so the bot's structured BOT_START_TIMEOUT lifecycle reaches main with margin before the outer generic timer would overwrite it.
  - Supervisor's summonResolved gate now accepts lifecycle 'error' as terminal (rejects summonPromise immediately). Previously only summon-ready cleared the gate, so a structured BOT_CRASH arriving at t=200ms could still be overwritten by a generic BOT_START_TIMEOUT at t=30s.
metrics:
  duration_minutes: ~25
  completed: 2026-05-08
status: 2-of-3-complete (Task C = human-verify checkpoint, deferred per plan)
---

# Quick Task 260508-nkk: CharacterPage wallpaper + summon-hang root cause Summary

Two regressions surfaced after 260508-mun shipped:
1. CharacterPage pixel-art was a 320×320 boxed island instead of a page wallpaper, with the eyebrow row showing as a solid-color band masking the top of the art.
2. Summon hung indefinitely on a confirmed-open LAN — only console output was the punycode DEP0040 deprecation noise.

Tasks A and B are committed code changes; Task C is the blocking human-verify checkpoint where the user walks the dev build to confirm both fixes against a live LAN-open Minecraft world.

## Task A — commit `1b40f24`: full-bleed wallpaper

**Files:** `src/renderer/src/screens/CharacterPage.tsx`, `src/renderer/src/screens/CharacterPage.module.css`

Added a `.bgArt` absolute-positioned layer (inset:0, z-index:0, pointer-events:none, aria-hidden) as the first child of `.root`. It hosts a second `<PixelPortrait>` instance with `size={1600}` so CSS `image-rendering:pixelated` upscales the 12×12 procedural sprite into the hero pixel-art wallpaper the user asked for.

Promoted `.crumb` and `.cols` to `position:relative; z-index:1` so the Back button, eyebrow ("CUSTOM"/"DEFAULT"), title, description card, stats grid, model row, portrait card and Summon CTA all float over the wallpaper. Existing card backgrounds (`var(--surface)`) keep them readable. Set `.root` background:transparent so the App-shell's `--bg` color does not mask the wallpaper from underneath.

The `.portraitCard` boxed PixelPortrait is preserved exactly as it was — the same deterministic sprite renders twice (once full-bleed, once boxed). `generatePixelGrid` is memoized on (seed, palette) so the cost of double-render is just one extra canvas paint.

The eyebrow row's "solid color band" perception is gone because nothing in `.right` or its parents has an opaque background; the wallpaper now reads through.

## Task B — commit `3fdf460`: summon-hang root cause + connect-timeout hardening

**Files:** `src/bot/index.js`, `src/bot/adapter/minecraft/connect.js`, `src/main/botSupervisor.ts`

### Root cause (identified by static analysis, NOT runtime repro)

The Electron utilityProcess path's `bootstrapWithInit()` constructed a config object and passed it directly to `start(config)`, **bypassing `ConfigSchema.parse(...)`**. The CLI path runs config through the schema; the Electron path didn't. Without schema-fill, several Zod defaults that the brain hard-requires were `undefined`:

| Field | Default | Used by |
|---|---|---|
| `memory.seed_diary_budget_bytes` | 3072 | `createDiary({...seedDiaryBudgetBytes})` — **throws synchronously if `<1`** |
| `memory.iteration_cap` | 30 | orchestrator iteration bound |
| `memory.spawn_settle_delay_ms` | 500 | sessionState owner-presence deferred check |
| `llm.rate_limit_per_min` | 30 | createTokenBucket |
| `llm.debounce_ms` | 500 | createDebouncer / createThrottle |
| `llm.max_hops` | 5 | createChainTracker |
| `anthropic.timeout_ms` | 20000 | every Anthropic.call |

`createDiary` synchronously throws `"createDiary: seedDiaryBudgetBytes must be >= 1"` inside `await startBrain(...)`. The throw was caught by `bootstrapWithInit`'s try/catch and emitted as a `BOT_CRASH` lifecycle. But the supervisor's `summonResolved` gate only triggered on `summon-ready` — the BOT_CRASH status did flip the renderer's CharacterPage model row to error briefly, but the 30s outer `summonTimer` kept running and could overwrite the specific message with a generic `BOT_START_TIMEOUT`. Depending on timing, the user would see indefinite "Connecting…" until the outer timer fired.

A second, independent bug compounded it: `summon-ready` was emitted as soon as `await start(config)` resolved — which happens BEFORE mineflayer's TCP handshake and `'spawn'` event. `summon-ready` therefore signaled "brain wired up," not "bot is online in the world." Any post-brain-wire mineflayer stall (wrong host, unreachable LAN, stalled Microsoft auth in the headless utilityProcess, native ABI mismatch) produced indefinite "Connecting…" with no diagnostic signal — exactly the user-reported symptom.

### Fix (4 parts)

1. **`src/bot/index.js` — schema-validate the config.** Imported `ConfigSchema` and ran `rawConfig` through `ConfigSchema.parse(...)`. On parse failure, emit `BOT_CRASH` lifecycle and return cleanly. This single change eliminates the entire class of "Electron path skipped a default."

2. **`src/bot/index.js` — accurate summon-ready timing.** Added a `hooks = { onReady, onConnectError }` arg to `start()`. `bringUp`'s `createBotInstance({onSpawn})` callback now invokes `onReady()` on the **first** mineflayer `'spawn'` (gated by `_readyFired` so reconnect-spawns don't duplicate). `bootstrapWithInit` passes `onReady: () => emitLifecycle({type:'summon-ready'})` so the lifecycle reflects actual world-spawn. `start()` rejecting still surfaces as `BOT_CRASH` via the outer catch.

3. **`src/bot/adapter/minecraft/connect.js` — wall-clock connect timeout.** Added `CONNECT_TIMEOUT_MS = 20_000`. A `setTimeout` wraps `createBotInstance` execution; if `'spawn'` doesn't fire in 20s, the timer force-quits the bot (`bot.quit('connect timeout')` + `bot.end()`), logs `host:port` + reason hint, and invokes `onConnectTimeout(err)` with a structured `BOT_START_TIMEOUT`-shaped Error. The timer is cleared on first spawn OR on early `'error'`/`'kicked'`/`'end'` so legitimate failures don't double-fire. `bootstrapWithInit` passes `onConnectError` to translate this into a `{type:'error', error:'BOT_START_TIMEOUT', message}` lifecycle. Per CLAUDE.md "every external call has a timeout."

4. **`src/main/botSupervisor.ts` — error lifecycle is terminal.** The `port1.on('message')` handler now treats `data.type === 'error'` the same way it treats `summon-ready` for the summonPromise: clears `summonTimer` and rejects with `${data.error}: ${data.message}`. The renderer-facing status was already correct via `lifecycleToStatus`; this fixes the bot:summon IPC await so it unblocks at the moment we have actionable info, not 30s later, and prevents the outer timer from overwriting a specific error with a generic BOT_START_TIMEOUT.

### Verification

`npm run build` — passes (electron-vite, three SSR/client bundles compile clean):

```
dist/main/index.js  28.50 kB
dist/preload/index.cjs  2.07 kB
dist/renderer/index.html  0.39 kB
dist/renderer/assets/index-CUT3reWk.css   38.70 kB
dist/renderer/assets/index-C8Wp1ep8.js   648.49 kB
```

There is no `npm run typecheck` script in this repo — `electron-vite build` runs the TS check as part of bundling, and the build succeeded. `node --check` on both modified `.js` files passes.

The synchronous `createDiary` throw was confirmed via a one-shot Node probe (`createDiary({path:'/tmp/x', seedDiaryBudgetBytes: undefined})` → `"createDiary: seedDiaryBudgetBytes must be >= 1"`). The schema fill was confirmed via a one-shot probe (`ConfigSchema.parse({...,memory:{owner_md_path,diary_md_path,affect_md_path},llm:{}})` → returned `seed_diary_budget_bytes: 3072`, `iteration_cap: 30`, `rate_limit_per_min: 30`, etc).

### Why we did NOT silence the punycode warning

It's Node 22+ noise from a transitive dep (likely tough-cookie via mineflayer's auth chain). Per the plan's explicit guard rail, left as-is.

## Task C — human-verify checkpoint (NOT executed by this run)

The plan's Task C is a `checkpoint:human-verify` gate. The executor environment for this run is a macOS Darwin agent terminal (`DISPLAY=` empty, no display server, no Minecraft instance, no LAN world). Visual verification of the wallpaper and live-world Summon verification are pending the user's walkthrough per the plan's "How to verify" section.

User-side acceptance criteria (verbatim from plan, recorded for traceability):
- **Task A:** From Home, click any character. Pixel art covers entire window — no solid-color band above the eyebrow row. Back button, eyebrow, title, description card, stats grid, model row, portrait card, Summon CTA all readable on top of the art.
- **Task B success path:** Within ~5–15s of clicking Summon on an open LAN world, model row flips to "Online · Ns" with green dot, bot appears in-game.
- **Task B failure path (acceptable):** Within ~20s, model row flips to a specific red-dot error (BOT_START_TIMEOUT, LAN_NOT_OPEN, INVALID_API_KEY) with actionable copy. **NOT** indefinite "Connecting…".
- **Unacceptable:** Connecting persists past 30s with no error → patch did not address the actual root cause; reopen this task.

## Build status

`npm run build` succeeds for both task commits.

## Self-Check

Files modified — diff present in HEAD~1..HEAD~0:
- src/renderer/src/screens/CharacterPage.tsx — FOUND
- src/renderer/src/screens/CharacterPage.module.css — FOUND
- src/bot/index.js — FOUND
- src/bot/adapter/minecraft/connect.js — FOUND
- src/main/botSupervisor.ts — FOUND

Commits — present in `git log`:
- 1b40f24 fix(quick-260508-nkk): make CharacterPage pixel-art a full-bleed wallpaper — FOUND
- 3fdf460 fix(quick-260508-nkk): root-cause summon hang and add connect-timeout hardening — FOUND

## Self-Check: PASSED

## Deferred / Surprises

- **Live verification deferred** — no display server, no Minecraft instance in this executor environment. Task C covers it.
- **Static-analysis-only diagnosis for Task B** — without a live repro, the root cause is identified via code review + a one-shot Node probe of `createDiary`. The fixes (schema-fill, spawn-gated summon-ready, connect timeout, terminal error lifecycle) address the diagnosed cause AND the broader class of post-brain-wire mineflayer stalls. If the user's specific hang has a different root cause, the connect-timeout hardening (mandatory regardless) will surface it as `BOT_START_TIMEOUT` within 20s with the host:port and reason hint in the message field — which is itself the next diagnostic.
- **`createBotInstance` is now slightly larger** because of the timer + cleanup machinery, but no API contract changed for non-Electron callers (`onConnectTimeout` is optional; the CLI path passes no hooks and the timer just adds a 20s safety net for the legacy CLI flow too).
- **Punycode DEP0040 is unchanged** — left as Node-runtime noise per plan's explicit guard rail.

## Deviations from Plan

None — plan executed as written. Auto-fix Rules 1/2/3 not triggered:
- Rule 1 (bug fix): the diary-budget validation throw IS the bug being fixed; not a new discovery.
- Rule 2 (missing critical functionality): the connect-timeout hardening was already in the plan as mandatory, not an auto-add.
- Rule 3 (blocking issue): no environmental blocker prevented the static-analysis path; the live-repro skip was an explicit plan-allowed fallback ("if no display server is available, SAY SO… skip live repro — fall back to static analysis only").
