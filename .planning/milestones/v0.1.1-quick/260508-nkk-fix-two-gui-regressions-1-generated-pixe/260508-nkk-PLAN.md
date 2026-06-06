---
quick_id: 260508-nkk
phase: quick
plan: 01
type: execute
wave: 1
mode: quick
depends_on: []
files_modified:
  - src/renderer/src/screens/CharacterPage.tsx
  - src/renderer/src/screens/CharacterPage.module.css
  - src/bot/index.js
  - src/bot/adapter/minecraft/connect.js
  - src/main/botSupervisor.ts
autonomous: false
tags: [electron, gui, bug-fix, summon, mineflayer, hang-diagnosis]
requirements: []
must_haves:
  truths:
    - "On CharacterPage, the pixel-art portrait fills the entire window (full-bleed background); the Custom/Default eyebrow + tabs/header float over the art with transparent backgrounds."
    - "The 'CUSTOM' / 'DEFAULT' eyebrow row is no longer rendered as an opaque solid-color strip masking the top of the art."
    - "When the user clicks Summon and the bot fails to reach summon-ready, the renderer surfaces a specific ErrorClass + actionable message within ~30s — never an indefinite 'connecting' state."
    - "Root cause of the current summon-hang on a confirmed-open LAN is identified in writing in this task's commit message (or the executor reports they could not reproduce + what was tried)."
    - "If the root cause is in mineflayer's connect path, a connect-level timeout exists so future hangs surface as `LAN_NOT_OPEN` / `BOT_START_TIMEOUT` instead of indefinite waits."
  artifacts:
    - path: "src/renderer/src/screens/CharacterPage.module.css"
      provides: "Full-bleed pixel-art background + transparent eyebrow/tab overlay styles"
    - path: "src/bot/adapter/minecraft/connect.js"
      provides: "Wall-clock connect timeout that rejects bringUp() if mineflayer.spawn never fires"
  key_links:
    - from: "src/bot/index.js (bootstrapWithInit)"
      to: "emitLifecycle({type:'summon-ready'})"
      via: "createBotInstance().on('spawn') chain"
      pattern: "summon-ready"
    - from: "src/bot/adapter/minecraft/connect.js"
      to: "createBotInstance reject path"
      via: "connect-timeout setTimeout"
      pattern: "BOT_START_TIMEOUT|connect.*timeout"

human_verify_required: true
---

<objective>
Fix two regressions surfaced after quick task 260508-mun shipped:

1. **CharacterPage pixel-art doesn't cover entire window** — currently a solid `var(--surface)` band (the `eyebrow` "CUSTOM"/"DEFAULT" row at the top of the right column) sits above the art and the portrait card itself is a 320×320 boxed island instead of a page-wide wallpaper. User wants the art to be the full-page background of CharacterPage with all UI floating over it.

2. **Summon hangs on confirmed-open LAN** — bot fork now starts (260508-mun fixed the dev fork-path regression to `dist/bot/index.js` → `src/bot/index.js`) but never emits `summon-ready`. The connecting toast persists. Only console output is the punycode DEP0040 noise (red herring). LAN is open and confirmed connected. The 30s `SUMMON_TIMEOUT_MS` in botSupervisor SHOULD eventually fire — task is to diagnose WHY summon-ready never reaches the supervisor and fix the root cause, plus add a connect-level timeout in the bot so future hangs surface as actionable errors instead of (a) waiting the full 30s with no signal or (b) hanging forever inside mineflayer's silent retry loop.

Purpose: Restore visual fidelity (item 1) and end-to-end summon flow (item 2) so the Electron GUI shipped in Phase 4 is usable.

Output: Updated CharacterPage layout + diagnosed-and-patched summon path + connect-timeout hardening in `src/bot/adapter/minecraft/connect.js`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@.planning/quick/260508-mun-make-ui-and-debug-fixes-to-electron-gui-/260508-mun-SUMMARY.md
@src/main/botSupervisor.ts
@src/bot/index.js
@src/renderer/src/screens/CharacterPage.tsx
@src/renderer/src/screens/CharacterPage.module.css
@src/renderer/src/components/PixelPortrait.tsx
@src/bot/adapter/minecraft/connect.js

<interfaces>
<!-- Lifecycle vocabulary (src/shared/ipc.ts) — bot → supervisor messages -->
type BotLifecycle =
  | { type: 'init-ack' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'error'; error: ErrorClass; message: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'summon-ready' }      // ← supervisor awaits THIS within 30s
  | { type: 'summon-stopped' }
  | { type: 'exit'; code: number };

<!-- Supervisor's summon flow (src/main/botSupervisor.ts) -->
// 1. supervisor.fork(botEntryPath()) → child + MessageChannelMain
// 2. child.once('spawn') → child.postMessage({type:'init', ...}, [port2])
// 3. supervisor awaits port1.message of {type:'summon-ready'} ≤ 30s
// 4. on timeout: status = {kind:'error', error:'BOT_START_TIMEOUT'}

<!-- Bot's bootstrapWithInit (src/bot/index.js) -->
// emitLifecycle({type:'init-ack'})
// _running = await start(config)            ← BLOCKS until mineflayer spawn
// emitLifecycle({type:'summon-ready'})       ← NEVER EMITTED if start() hangs

<!-- The hang is inside `await start(config)` because mineflayer's spawn
     never fires (or fires but the chain stalls). start() → bringUp() →
     createBotInstance() returns synchronously, then mineflayer's connect
     proceeds in the background; brain start happens before spawn. The
     'summon-ready' emit happens AFTER start() resolves, but start() does
     NOT await spawn — it returns once createBotInstance has set up
     listeners. Re-read src/bot/index.js:start() and connect.js to
     confirm whether bringUp resolves before or after 'spawn' before
     prescribing a fix. -->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task A: Make CharacterPage pixel-art full-bleed wallpaper</name>
  <files>src/renderer/src/screens/CharacterPage.tsx, src/renderer/src/screens/CharacterPage.module.css</files>
  <action>
Restructure CharacterPage so the pixel art covers the entire window (full-bleed background) with all other UI floating on top with transparent backgrounds.

Current layout (`CharacterPage.module.css`): `.root` is a flex column with `padding: 24px 40px 40px`. Inside, `.crumb` (Back button row) sits at top, then `.cols` is a 320px+1fr grid. Inside the right column `.right`, the FIRST element is `.eyebrow` (font-mono 11px "CUSTOM"/"DEFAULT") rendered against the page's default `var(--bg)` surface. Inside the LEFT column `.left`, `.portraitCard` is a 320×320 box with `background: var(--surface)` containing the `<PixelPortrait>` — currently the portrait is constrained to that 320×320 island.

The user's intent (per task description): the portrait/pixel-art should be the full-page wallpaper of CharacterPage, with the existing UI (Back, eyebrow, title, description card, stats, Summon CTA, Edit/Delete) floating over it.

Implementation:

1. **Render PixelPortrait as a fixed-position background layer** behind all CharacterPage content:
   - Add a new `.bgArt` element as the FIRST child of `.root`, positioned `absolute` (or `fixed` within the page container) covering the full `.root` bounds.
   - Move the `<PixelPortrait>` instance into `.bgArt` and pass `size={Math.max(window.innerWidth, window.innerHeight)}` (or use 100% width/height with CSS scaling). Verify PixelPortrait accepts non-square — if it's strictly square, wrap it in a div sized to viewport with `overflow: hidden` and let the canvas overflow / center.
   - Read `src/renderer/src/components/PixelPortrait.tsx` first to confirm the component's sizing contract before deciding between (a) passing a viewport-sized `size` prop, or (b) wrapping in an `overflow:hidden` viewport div with a centered/scaled canvas.
   - Keep the existing `.portraitCard` 320×320 portrait in the left column — the SAME portrait can render twice (once full-bleed, once boxed). This gives the user the wallpaper effect while preserving the current portrait card composition.

2. **Make overlay UI transparent so the art shows through**:
   - `.root`: add `position: relative` (so the absolute-positioned `.bgArt` anchors to it) and ensure `min-height: 100%` already works. Z-index: contents above bg.
   - `.bgArt`: `position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none;` — pointer-events:none so clicks fall through to underlying buttons would only matter if the art covered actual interactives, but since the art is BEHIND (`z-index:0`) and `.cols` etc sit at `z-index:1`, this is belt-and-suspenders.
   - `.crumb`, `.eyebrow`, `.title`: ensure no opaque background. The eyebrow currently has none directly, but check whether the SCREEN has a wrapper with `var(--bg)` (the parent `<main>` in App.tsx may have one). If so, set `.root { background: transparent; }`.
   - `.card` (Description), `.stat`, `.modelRow`, `.portraitCard`: these are PRESERVED with their `background: var(--surface)` so they remain readable cards on top of the art. Optionally add `backdrop-filter: blur(4px)` for legibility, but only if the art is busy enough to need it — leave that as a CSS comment for the human-verify checkpoint to decide.
   - Add `position: relative; z-index: 1;` on `.cols` and `.crumb` so they stack above `.bgArt`.

3. **Remove the solid-band illusion**: the user perceives the eyebrow row as a solid color band masking the top of the art. After step 2, the eyebrow ("CUSTOM"/"DEFAULT") will sit on transparent background and the art shows through. No code change is needed beyond verifying nothing in `.right` or its parents has an opaque background.

4. **Pixel-art sizing**: the goal is for the art to feel like a wallpaper, NOT a tiny portrait re-stretched. If `PixelPortrait` upscales by integer multiplication on a small grid (e.g., 16×16 cells), passing `size={1600}` may produce huge blocks — that's fine for a pixel-art aesthetic. If it produces unacceptable visual artifacts in the human-verify pass, the fallback is to set the bg-art container's CSS to `image-rendering: pixelated; transform: scale(N);` and let the existing `<PixelPortrait size={320} />` upscale via CSS. Decide based on what PixelPortrait actually renders.

5. **Z-stacking sanity**: walk the JSX after the change and confirm:
   - `.bgArt` (z=0) sits below `.crumb`, `.cols`, `.left`, `.right`, modals.
   - `EditCharacterModal` and `DeleteConfirmModal` already use their own portal/scrim with high z-index — should be unaffected.
   - The Settings/Onboarding screens and HomeScreen do NOT regress (this CSS module is scoped to CharacterPage; only `:root`-level changes would leak — none planned).

6. **Cleanup**: the unused `.tabs`, `.tab`, `.tabActive`, `.tabDisabled`, `.cardExpanded`, `.toggle`, `.personaBody`, `.logsWrap` classes from the prior 260508-mun cleanup are still in `.module.css`. LEAVE THEM (per 260508-mun summary's "do not delete unused CSS to keep churn small" guidance).

Do NOT touch HomeScreen, Settings, Onboarding, IconRail, or LogsBar. Scope is CharacterPage only.
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && npm run typecheck 2>&1 | tail -20 && npm run build 2>&1 | tail -10</automated>
  </verify>
  <done>
- `npm run typecheck` passes (no new TS errors).
- `npm run build` completes successfully.
- `CharacterPage.module.css` contains a `.bgArt` rule with `position: absolute; inset: 0;` (or fixed equivalent) and z-index ordering placing content above it.
- `CharacterPage.tsx` renders `<PixelPortrait>` inside the `.bgArt` element AND inside `.portraitCard` (or, if a single-render approach is taken, the `.portraitCard` is preserved visually). Visual verification deferred to Task C (human-verify).
  </done>
</task>

<task type="auto">
  <name>Task B: Diagnose & fix summon hang + add connect-timeout hardening</name>
  <files>src/bot/index.js, src/bot/adapter/minecraft/connect.js, src/main/botSupervisor.ts (only if hang is on the supervisor side)</files>
  <action>
**This is a diagnose-then-patch task. Do NOT prescribe a specific fix in this plan — read the code, run the dev build, read the live logs, then patch the actual cause.**

The symptom: user clicks Summon, connecting toast appears, then nothing. Only console output is `(node:NNNNN) [DEP0040] DeprecationWarning: The punycode module is deprecated.` (THIS IS NOISE — Node 22+ emits it for any transitive userland use; do NOT chase it).

Prior fix (260508-mun, commit 17f3e48) corrected the dev fork-path so the bot now actually starts. The new failure is: bot starts, but `summon-ready` lifecycle message never reaches the supervisor's port1.

### Step 1 — Reproduce + collect evidence

1. Run `cd /Users/ouen/slop/sei && npm run dev` in a terminal (executor: if no display server is available, SAY SO in your final report and skip live repro — fall back to static analysis only).
2. Open Minecraft, open world to LAN, confirm the Sei GUI shows LAN: connected.
3. Click Summon on a character.
4. Capture the FULL terminal output, including:
   - `[bot-stdout] ...` lines (mirrored from utilityProcess stdout)
   - `[bot-stderr] ...` lines (mirrored from utilityProcess stderr)
   - `[lifecycle] ...` lines (the bot's own emitLifecycle stdout mirror)
   - `[sei] ...` lines (logger output from both supervisor and bot)
5. Wait the full 30s. Note whether `BOT_START_TIMEOUT` fires (supervisor's `summonTimer`). If yes → bot is alive but not emitting summon-ready. If no → supervisor itself is wedged (very unlikely given 260508-mun hardening, but possible).

### Step 2 — Map evidence to candidate root causes

Read these in order, cross-referencing the captured logs:

- **`src/bot/index.js` `bootstrapWithInit`** — confirm `[lifecycle] {"type":"init-ack"}` reached stdout. If yes, the IPC init handshake works.
- **`src/bot/index.js` `start(config)`** — does it `await` mineflayer's `'spawn'` event? Currently `start()` calls `bringUp()` which calls `createBotInstance({...onSpawn: () => {...}})` and returns synchronously. The `summon-ready` emit happens AFTER `await start(config)` resolves. If `start()` resolves BEFORE spawn (likely), `summon-ready` would emit immediately on connection-init, NOT on actual world-spawn. Re-read carefully — this is suspicious.
- **`src/bot/adapter/minecraft/connect.js` `createBotInstance`** — does the bot emit `'spawn'` ever, or does it stall in handshake (e.g., wrong protocol version, auth mismatch, packet decode error)? mineflayer's silent failure modes:
  - **Microsoft auth flow blocking on a device-code prompt** that no human will ever see (utilityProcess has no TTY). If `auth: 'microsoft'` and there's no cached token, msmc/prismarine-auth waits indefinitely on stdin.
  - **Wrong protocol version** — `version: 'auto'` triggers a ping-then-handshake; if ping succeeds but handshake mismatches (e.g., LAN is on a snapshot), bot retries silently.
  - **Loopback host vs LAN broadcast host** — code passes `host: 'localhost'` and `port: lanPort` (random LAN port). If Bonjour discovered the port from a hostname like `WickedTuna.local` and the LAN host actually binds only to that interface (not 127.0.0.1), connect to localhost SYN-ACKs but the server never responds. CHECK: what address does the bonjour watcher actually report? Does main `latestLanState` carry a host, or only a port? (Currently `getLanPort()` returns only the port — host is hardcoded to `'localhost'` in `bot/index.js` bootstrapWithInit. If the LAN bound to a non-loopback interface, this is the bug.)
  - **mineflayer dependency native ABI mismatch** — `@electron/rebuild` should fire on postinstall. Check `package.json` postinstall script and verify `node_modules/.cache/electron-rebuild-cache` or just attempt a fresh `npm rebuild` in the worktree. If a native binding throws on require, the bot's `surfaceCrash` handlers (260508-mun) should catch it and emit a `[sei-bot uncaughtException]` to stderr — look for that.
- **`src/main/botSupervisor.ts` `port1.on('message')`** — confirm the message handler is wired before `port1.start()`. It is (lines 321-331). No bug there.

### Step 3 — Identify root cause

From the evidence + code review, write a 2–4 sentence root cause statement in the commit message body. Examples (NOT exhaustive — find the actual cause):

- "mineflayer's `'spawn'` never fires because `start()` resolves before spawn, so summon-ready is emitted prematurely BUT mineflayer is silently stalling on Microsoft auth in the utilityProcess. Fix: switch to `auth: 'offline'` for LAN connections (LAN doesn't validate Microsoft auth) and emit summon-ready from the actual mineflayer `'spawn'` event, not from `start()`'s return."

- "The bonjour-discovered LAN port is correct, but the bonjour record's `host` field is `WickedTuna.local` (not loopback). The bot connects to `localhost:<port>` and the server never accepts. Fix: thread `host` through `getLanPort` → init message → bot config so the bot uses the actual advertised host."

- "`createBotInstance` swallows the connect rejection because `bringUp()` doesn't await `'spawn'` and there's no connect-level timeout. The bot is in a silent infinite retry inside mineflayer's TCP backoff. Fix: add a 25s wall-clock connect timeout in `connect.js` that rejects with `BOT_START_TIMEOUT` if `'spawn'` never fires."

### Step 4 — Patch the root cause

Apply the minimal fix that addresses the diagnosed cause. Keep the change scoped — do NOT refactor unrelated code. The fix MAY span any of: `src/bot/index.js`, `src/bot/adapter/minecraft/connect.js`, `src/main/botSupervisor.ts` (only if the diagnosis points there).

If the root cause turns out to be in main process plumbing (e.g., LAN host not threaded through), update `BotSupervisorOptions.getLanPort` → `getLanInfo()` returning `{host, port} | null`, plumb through `init` message, and use in bot's `bootstrapWithInit`. Update `src/shared/ipc.ts` lifecycle / init types if the init payload shape changes.

### Step 5 — Mandatory hardening: connect-level timeout

Regardless of what the root cause is, ADD a wall-clock connect timeout inside the bot so a future hang of the same shape surfaces as `BOT_START_TIMEOUT` instead of waiting the supervisor's full 30s with zero diagnostic signal:

In `src/bot/adapter/minecraft/connect.js` (or wherever `createBotInstance` lives):
- Wrap the bot creation in a Promise that resolves on first `'spawn'` (or `'login'` if spawn is too late) and rejects on `setTimeout(reject, CONNECT_TIMEOUT_MS = 20_000)` OR on `'kicked'` / `'error'` events.
- Surface the rejection up through `start()` so `bootstrapWithInit`'s catch path emits `{type:'error', error:'BOT_START_TIMEOUT', message: 'mineflayer.spawn did not fire within 20s — LAN host/port mismatch or auth stalled'}`.
- Per CLAUDE.md "Every external call has a timeout" — this is mandatory.

If the root-cause fix already includes a connect timeout (e.g., the diagnosis IS "no connect timeout"), the hardening is part of the fix and a separate timeout is not needed — but verify the timeout is ≤ 20s (well under the supervisor's 30s) so the bot's lifecycle error message reaches the supervisor before SUMMON_TIMEOUT_MS fires.

### Step 6 — Do NOT silence the punycode warning

It's noise from a transitive dep. Leave it.

### Out-of-scope guard rails

- Do NOT change the action registry, brain, FSM, or any Phase 1–3 code.
- Do NOT change the renderer's CharacterPage Banner / status display logic.
- Do NOT switch auth providers without explicit diagnosis pointing there.
- Mineflayer must remain in utilityProcess only (CLAUDE.md constraint).
  </action>
  <verify>
    <automated>cd /Users/ouen/slop/sei && npm run typecheck 2>&1 | tail -20 && npm run build 2>&1 | tail -10</automated>
  </verify>
  <done>
- Root cause is documented in the commit message body (2–4 sentences) OR the executor reports they could not reproduce in their environment + lists what they tried statically.
- The diagnosed root cause is patched.
- A wall-clock connect timeout (≤ 20s) exists in the bot's mineflayer connect path that emits a lifecycle `{type:'error', error:'BOT_START_TIMEOUT', message:...}` if `'spawn'` never fires.
- `npm run typecheck` and `npm run build` both pass.
- Live verification deferred to Task C (human-verify checkpoint).
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task C: Human verify both fixes against live dev build</name>
  <what-built>
- Task A: CharacterPage pixel-art now full-bleed wallpaper, eyebrow + UI float over art with transparent backgrounds.
- Task B: Summon hang root-caused and patched; bot's mineflayer connect now has a wall-clock timeout that surfaces failures as `BOT_START_TIMEOUT` lifecycle errors within ~20s.
  </what-built>
  <how-to-verify>
1. **Start the dev build:** `cd /Users/ouen/slop/sei && npm run dev`
   - Wait for the Electron window to appear AND for the renderer dev server to log "ready".
   - If the executor's environment has no display server, SKIP this checkpoint and the user runs it manually — the executor must clearly say so in their final report.

2. **Verify Task A — CharacterPage wallpaper:**
   - From Home, click any character (Sui or a custom one).
   - Confirm the pixel art covers the entire window (no solid-color band at the top above the "CUSTOM" / "DEFAULT" eyebrow row).
   - Confirm the Back button, eyebrow, title, description card, stats grid, model row, portrait card, and Summon CTA are all readable on top of the art.
   - Resize the window — art should re-fill (or at least not leave gaps); if it does leave gaps, note it as a follow-up but don't block.

3. **Verify Task B — Summon flow:**
   - Open Minecraft, open world to LAN. Wait for the Sei GUI to show LAN: connected.
   - Click Summon. Watch the terminal for `[bot-stdout]`, `[bot-stderr]`, `[lifecycle]`, `[sei]` lines.
   - **Success path:** within ~5–15s the model row flips to "Online · Ns" with green dot, and the bot appears in-game.
   - **Failure path (acceptable):** within ~20s the model row flips to a red-dot error with a SPECIFIC message (e.g., `BOT_START_TIMEOUT`, `LAN_NOT_OPEN`, `INVALID_API_KEY`). NOT an indefinite "Connecting…" state.
   - **Unacceptable:** "Connecting…" persists past 30s with no error → re-open this task, the patch didn't address the actual root cause.

4. **Confirm punycode noise is unchanged** (we did not silence it; it's a Node 22+ dep warning unrelated to our code).

5. **Quick regression sanity:**
   - Click Stop. Bot disconnects cleanly within 10s.
   - Click another character's Summon. Bot switches without the supervisor leaking the previous session.
   - Open Settings. Inline-edit username/preferred-name still works (260508-mun item 7, no regression expected).
  </how-to-verify>
  <resume-signal>Type "approved" if both fixes work and the wallpaper looks right, OR describe issues (e.g., "summon still hangs, here's the log:") so the executor can iterate.</resume-signal>
</task>

</tasks>

<verification>
- `npm run typecheck` passes after both Task A and Task B changes.
- `npm run build` completes without errors.
- Human-verify checkpoint (Task C) confirms:
  (a) CharacterPage pixel-art covers full window with floating UI overlay.
  (b) Summon either succeeds within ~15s OR surfaces a specific ErrorClass within ~20s — never an indefinite hang.
- Commit message body for Task B contains a written root-cause statement (2–4 sentences).
</verification>

<success_criteria>
- Two regressions resolved: CharacterPage wallpaper + summon-hang.
- Connect-timeout hardening committed, ensuring future mineflayer hangs surface as `BOT_START_TIMEOUT` in ≤ 20s instead of waiting on the supervisor's 30s outer timer or hanging indefinitely.
- No regression on prior 260508-mun fixes (LogsBar, EditCharacterModal, inline Settings edit, sidebar gating during onboarding, dev fork-path resolution).
- All changes commit as `fix(260508-nkk): ...` with the diagnosed root cause in the body.
</success_criteria>

<output>
After completion, create `.planning/quick/260508-nkk-fix-two-gui-regressions-1-generated-pixe/260508-nkk-SUMMARY.md` capturing:
- The diagnosed root cause for Task B (verbatim or expanded from commit message body).
- Files modified per task.
- Whether the human-verify checkpoint passed live, or was deferred to the user.
- Any deviations or surprises encountered during diagnosis.
</output>
