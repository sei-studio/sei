# Instrumenting a game or timed surface (REQUIRED)

**Every new game, minigame, or timed surface MUST emit analytics before it
ships.** This is not optional polish. Chess shipped in v0.5.0 with zero
instrumentation and voice calls shipped in v0.4.x the same way, so for three
weeks the dashboard's "minutes" meant *Minecraft only* and the question "is
anyone playing chess?" had no answer from any source: PostHog had no chess
event, and `ledger_consumption` records spend with no surface column, so the
cost could not be attributed either. Fixed 260728.

The contract is two events per surface:

- **`<surface>_started`** — fired when the surface actually opens, with the
  parameters that shape the session (for chess: `player_color`, `ai_elo`,
  `profile_source`).
- **`<surface>_ended`** — fired at the single lifecycle choke point, carrying
  **`duration_ms`**. That key name is load-bearing: the analytics dashboard
  sums playtime with one query across every event in its `SESSION_EVENTS` list
  (`analytics/server.mjs`), so a surface that names its duration field anything
  else is invisible in playtime. Also send `character_id` and an outcome.

Rules that follow from the existing implementations:

- Fire `_ended` on **abandoned/aborted** sessions too, with a `reason` — that
  time was still spent. `chessService.endSession` is the choke point precisely
  because every exit path (resign, draw, checkmate, abandon, engine failure)
  routes through it.
- Emit only **shape, never content**: no board state, no chat text, no persona.
- Use a **lazy `await import('../analytics')` inside a fire-and-forget block**,
  so the module graph and the tests never depend on analytics being
  initialized. `capture()` is already a no-op when uninitialized or opted out.
  260926: chess, Draw! and backseat go through `loadAnalytics()`
  (`src/main/lazyAnalytics.ts`), one cached lazy import. Two separate
  `import('../analytics')` calls in the same tick can resolve to different
  instances under vitest mocking, so a mocked `capture` silently misses the
  second event. Prefer it for new capture sites.
- Then add the new `_ended` name to `SESSION_EVENTS` in the analytics repo
  (`~/slop/sei-studio/analytics/server.mjs`) and a label in `SURFACE_LABEL`
  (`public/app.js`). That is the only dashboard change needed.

Current members: `bot_session_ended` (Minecraft), `chess_game_ended`,
`voice_call_ended`, `draw_game_ended`, `backseat_ended`, `chat_session_ended`.

**`bot_session_ended` says why (260929).** It used to carry no reason, so a
player pressing Stop looked exactly like a kick loop, and 10 of 36 Minecraft
users in a month had sub-minute sessions nobody could explain. It now carries
`reason` (`user_stop`, `companion_quit`, `app_quit`, `account_switch`,
`kicked`, `world_closed`, `disconnected`, `credits_depleted`, `rate_limited`,
`crash`, `error`, `bot_exit`, `unknown`), plus `error_class` when it ended on
an error, `kick_code` for a kick, and `duration_s` beside `duration_ms`. The
supervisor stamps `endReason` (and `kickCode`) on the terminal BotStatus:
`supervisor.stop(id, reason)` for stops, the bot's `summon-stopped` reason for
a companion quit(), and the Minecraft runtime's `fail(message, {endReason,
kickCode})` for post-spawn drops. `src/main/sessionEnd.ts` maps a status to
props (pinned in `sessionEnd.test.ts`). `kick_code` comes from
`kickReasonCode()` in `connect.js`: a vanilla `disconnect.*` key or a fixed
code, never the host's kick text. A session that ended on an error also
fires **`bot_session_failed`** (same props, `duration_s` only, not a playtime
event), the post-join counterpart of `summon_failed`. One overlap is kept on
purpose (dashboards read it): a mid-session crash exit (nonzero exit code
after summon-ready) fires BOTH `summon_failed` with `summon_phase:
'mid_session'` AND `bot_session_failed` with `reason: 'crash'`. A query that
adds the two to count failures must drop one of them, e.g. exclude
`summon_phase = 'mid_session'` from `summon_failed`. Other post-join failures
(kick loops, lifecycle errors) fire only `bot_session_failed`. App quit closes live
sessions in `before-quit` BEFORE the analytics flush (`app_quit`); the
drain's own idle statuses come after the flush and used to be lost. That
flush runs before `supervisor.shutdown()`, so it is bounded
(`ANALYTICS_SHUTDOWN_TIMEOUT_MS`, 2.5s): posthog-node's own default is 30s,
and with PostHog unreachable quit hung that long with the bot still in the
world.

**Goodbyes can set up the next session (261008, retention fix 2(c)).** Every
goodbye tool (bot `quit_game` / `end_call`, chat-surface `quit_game` /
`end_call`) takes an optional `next_time` field (prompt text in
promptLibrary `NEXT_TIME_FIELD` / `NEXT_TIME_GOODBYE` / `NEXT_TIME_SPOKEN`).
The model works the step into its own goodbye; the host only saves the
field to MEMORY.md as `Plan for next time: <step>` (`src/bot/brain/nextStep.js`,
bot `saveNextStep`, chat `honorNextStep`), and the next greeting (bot FIRST
CONTACT, voice-call greeting note) is told it may bring it up
(`NEXT_TIME_GREETING`). No extra LLM call. Analytics are booleans only:
`bot_session_ended.next_step_hook`, `voice_call_ended.next_step_hook` and
`ended_by_companion`. The goodbye and the end event come from different
processes, so `src/main/sessionGoodbye.ts` holds a short-lived note between
them. A player Stop, player hang-up or world close has no companion goodbye
and reports `false`; a hook set by the goodbye adds `next_step_source:
'companion'`.

**Player-ended sessions get the same hook (261011).** Most sessions end with
the player (Stop, closing the world, hanging up), so main runs ONE small
background call after teardown (`src/main/playerEndNextStep.ts`, system text
promptLibrary `PLAYER_END_NEXT_STEP_SYSTEM`) on the session's own provider:
max 150 output tokens, input = the last 16 conversation lines, the game's
goals (`HEARTBEAT[.game].md`) and the MEMORY.md tail; it answers a few-word
plan or `none`, saved with the same `Plan for next time:` line. Covered:
every bot game (closePlaySession on `user_stop` / `world_closed` /
`disconnected`; the bot posts a `{type:'session-digest'}` port message,
`src/bot/brain/sessionDigest.js`, fed by convoMemory's `onLine` tap), an
out-of-game call the player hung up (voice rows of the chat transcript), and
a backseat the player ended (`endBackseat(..., { playerEnded: true })` from
the IPC End handler only). Rules: skipped under 2 min or with fewer than two
player lines and no goal, when offline (remote models), or when
`cloudOverLimit()` (never raises the wall); time-boxed at 15 s
(`providerTimeoutMs` floor for local models); single-flight per character
with a 60 s dedupe; a new session aborts a check running on Ollama; runs as a
scoped turn so an account switch drops the write. Never awaited by teardown.
Analytics are shape only: `next_step_checked {source:'player_end', surface,
game?, saved, outcome}` and `next_step_saved {source:'player_end', surface,
game?}` as follow-ups (the `_ended` event has already gone out). Live check:
`npx tsx scripts/player-end-next-step-probe.ts --reps 3`.

**The Home "up next" strip reads those plans back (261013, T119).** One
strip above the party wall: the first Home companion (wall order) with an
unconsumed `Plan for next time:` under 7 days old, else the first with an
active goal (`HEARTBEAT[.game].md`, also under 7 days), with one button that
reuses the tile launch paths (bot game: gate + `openGame`; backseat game: its
modal; call: `startOrOpenCall`; unknown: the games picker). No plan and no
goal renders nothing. Companions in a game or call are skipped; the x hides a
card for the app session. Rules: `src/main/homeNextStep.ts` (pure +
tested). MEMORY.md does not say where a plan came from and is model-facing,
so main keeps a sidecar `NEXT_STEP.json` in the memory dir: tags (plan text
key -> surface/game, written right after a goodbye plan or a player-end save)
and a `consumedAt` watermark set when a bot session goes online or a call
greeting runs (both greetings are told about the plan). Only the NEWEST plan
counts: a consumed or expired newest plan never falls back to an older one.
IPC `home:next-steps` + push `home:next-step-changed`; renderer
`lib/homeNextStep.ts`, `useHomeNextStepStore` (cleared on account switch),
`HomeNextStepCard`. Events (shape only): `home_next_step_shown` (once per
card per app session) and `home_next_step_clicked`, both `{character_id,
source: plan|goal, age_hours, surface: game|call|backseat|unknown, game?}`.
Verify with `?dashshot=home&step=plan|call|untagged|goal|long|none`.

**Strip text addressed to the player, and greetings that raise the plan
(261014).** The saved plan is the companion's private note ("ask Alex what
the vet says about Pepper's leg on Thursday"); shown verbatim on the strip it
talked about the player in the third person and kept stale days
("tomorrow"). So every plan writer also produces a short line written TO the
player ("Tell Roger what the vet said about Pepper"): the player-end check
answers two labeled lines, `note:` and `player:` (`PLAYER_END_NEXT_STEP_SYSTEM`,
parsed by `parsePlayerEndReply`; an unlabeled reply still reads as the note
alone), and every goodbye tool has an optional `next_time_for_player` field
(`NEXT_TIME_FOR_PLAYER_FIELD`). The line never goes into MEMORY.md (the model
would read it as a second plan): it rides to main (bot: `nextStepLine` on
`summon-stopped` / `call-end`; chat: `honorNextStep`'s result) through the
goodbye note in `sessionGoodbye.ts` (never analytics) and is stored as `line`
on the plan's tag in `NEXT_STEP.json`. `nextStep.js normalizePlayerLine`
cleans it (drops tomorrow/tonight anywhere and next time/later/today at the
edges, cuts past 60 chars at a clause break, hard cap 90 with an ellipsis;
idempotent, since main runs it again, and a possessive like "tonight's
stream" is left alone). Before storing, `tagLatestPlan` checks it with
`acceptPlayerLine` / `playerLineProblem` against the companion and player
names (`playerLineNames.ts`): a line that opens like a note to self ("ask
how...", "remember to...", "find out..." not followed by the companion's
name), names the player in the third person, or uses I/me/we is dropped.
The card shows the tag's line, else the note as before (old plans, a goodbye
that left the field out, a dropped line). The player-end prompt names the companion with
`nameInSentence` (`src/shared/homeNextStep.ts`), which the card also uses for
"Up next with Red" / "Call Red": an all-lowercase name gets its first letter
raised in those sentences only (the party tile caption keeps it as typed).
Greetings: main reads the OPEN plan (`readPendingPlan`: newest, under 7 days,
unconsumed) before marking it used and hands it over, as init `nextStepPlan`
-> `config._seiNextStepPlan` -> `FIRST_CONTACT({ plan })` for a game, and as
`sendVoiceGreetingTurn(id, peers, { plan })` -> `callGreetingNote` for a
call. With a plan, `nextTimeGreeting(plan)` quotes it and asks for it to be
the main thing the greeting is about (the "only a hint" escape is left out);
`null` means none open and drops the hint entirely, so an old raised plan
still in MEMORY.md is not raised again; `undefined` (CLI, or the supervisor's 1s
plan read timing out) keeps the old soft hint. Two wording traps found live: the cue must not say "the last thing
said" (the call primer's `(silence)` rule keys on it), and must not call the
plan a "note" (collides with the call's "Do not mention this note"); both
made calls answer with `(silence)`. The call greeting now also says it is
never `(silence)`. Probe: `npx tsx scripts/next-step-examples.ts` (10 scripted
sessions, plan reps + greetings, `--greet-only <results.json> --greet-reps 4`)
and `scripts/next-step-examples-strips.ts` (renders the strips via
`?dashshot=home&name=&text=&surface=`). 261014 run: greetings raised the plan
36 of 36 (was 26 of 36; Marv 0 of 4 and Roger 1 of 4 before).

**Plans and goals belong to a game (261020).** Live on v0.6.9-beta.3: a
Minecraft build (a copper bulb lighthouse, discussed in a text chat) showed on
Home as "Get copper for ouen's copper bulb lighthouse" with Play Stardew
Valley. Chat memories had been filed under the last world's header (a Stardew
farm), nothing in a game's seed said memories span games, so the Stardew
session greeted with the plan, setGoal'd it into `HEARTBEAT.stardew.md`, and
the player-end check tagged its plan with the session's game. Now:
- MEMORY.md sections name their game (`## World 2 — Sui Farm (Stardew
  Valley)`, `noteWorld(..., game)`), and app-side writers (chat, voice,
  chess, Draw!, backseat, an out-of-game player-end plan) pass
  `appendMemory(..., { section: 'app' })`, which opens
  `APP_SECTION_HEADER` when the last section is a world. Seed truncation, the
  compactor and the dedupe guard split on any `## ` header.
- Plan lines carry their game: `Plan for next time in Minecraft: ...`
  (`nextStepMemoryLine(step, gameName)`, read back by `parsePlanLine`). The
  player-end check answers a third line, `game:` (a game or `none`), decided
  from the step, not the session (`resolvePlanPlace`); its memories are
  grouped under their section headers (`memoryEntries`), which is what lets
  it tell Minecraft copper from Stardew copper (live probe: 0 of 4 right
  without the headers, every labeled answer right with them).
- `readPendingPlan` / `consumeNextStep` take `{ game }`: a game session
  neither greets with nor consumes a plan for another game.
- Game seeds say memories span games and another game's plans stay there
  (`memoryGameScope`, `chatContinuityGameScope`, heartbeat header names the
  game); setGoal's description says a goal is for the current game and to
  start with a headline that leaves the player's name out. Prompt only, no
  matcher. Unverified live in Stardew. Old data is not migrated: an existing
  wrong goal in `HEARTBEAT.stardew.md` still shows until cleared.
- Goodbye plans name their game too: quit_game, end_call (bot) and the chat
  end_call take `next_time_game` (`NEXT_TIME_GAME_FIELD`, static text),
  parsed by `parsePlanGameField` (a whole id, name, leading part of a name
  or short name like MC/DST; a short answer starting with none is `none`;
  "craft" or "Minecraft Dungeons" is no game). Main tags the ledger with
  `goodbyePlanPlace`: a named game wins; `none` drops the game (Home shows
  the picker); a missing field keeps the in-game session's game and leaves a
  call plan unscoped. The memory line's label follows the same rule (bot
  end_call `saveNextStep(..., { call: true })`, chat quit_game `liveGame`
  from main's `sessionGame`). A game session
  that loads an unscoped or other-surface plan (`readPendingPlanFor`,
  `notForGame`) greets with it as something to talk about, not a task to
  start (`nextTimeGreeting(plan, { notForGame })`). The player-end parser only
  splits a run-on reply at a later label in order (`note`, `player`, `game`),
  and at `game:` only when the rest is an exact game or `none`, so a step
  like "play the board game: Catan" stays whole. Live Haiku probe of the
  field (forced tool, 16 runs: MC plan quit from Stardew, Stardew plan, MC
  plan on a call, non-game call plan): 16 of 16 right.

**Sessions an app quit ended get the check on the next launch (261013,
T120).** Quit (window close on Windows, Cmd-Q, app quit with a bot or call
live) has no time for an LLM call, so it never ran the player-end check
(live 0.6.8: 3 of 73 session ends had a hook). `src/main/quitNextStep.ts`
splits it across the quit. In before-quit, `closePlaySession` with reason
`app_quit` (skipped when a goodbye already ended it) and `persistCallsForQuit`
(out-of-game calls that connected, `callState.liveCallsNow`) write
`PENDING_NEXT_STEP.json` to the character's memory dir: synchronous
mkdir + write + rename of a few KB, try/catch, no network or await, so it
cannot delay or break quit. A game keeps its session digest (refreshed by
the final digest the bot posts while `supervisor.shutdown()` drains it,
`refreshQuitDigest`); a call keeps only its window (its lines are voice rows
in the transcript). Sessions under 2 min write nothing. On the next launch
(`LAUNCH_DELAY_MS` 10 s after bootstrap, and after every scope switch via
`initProfileScope({ onScopeSwitched })`) each pending file in the active
profile runs through `startPlayerEndNextStep` (same gates: trivial, offline,
over limit, local time box, scoped turn; plus a cloud backend needs a
signed-in session first, else the file waits), saves + tags the plan and
notifies Home. Deleted after any answer; kept for up to 3 launches when the
check failed (offline / error / timeout), kept as is when busy or cancelled.
Dropped unrun after 7 days, or when a newer session with the character
started (game online / call greeting this run, `noteNewSessionForQuit`, or a
later bot-game play / call row in the transcript); such a check in flight is
aborted on any provider (`yieldAlways`). Events: the same
`next_step_checked` / `next_step_saved` with `source: 'app_quit'` and
`late_hours`. Not covered: a crash or force-kill (nothing runs at exit), and
on macOS a call whose window was closed earlier still counts as live at the
later Cmd-Q (its duration is overstated; the lines are right).

**Every session end reports its next step (261107, O2 reach).** Only 12% of
10-05..10-27 installs had a `next_step_saved`, mostly because the check
shipped in stable 0.6.9 (10-24): earlier installs never ran it. On 0.6.9+
the gaps were Stardew/DST (closing the game arrived as `error` /
GAME_WORLD_NOT_OPEN, never `world_closed`), calls ended by closing the
window (main closes them in `sweepVoiceCalls`; on Windows the window's
`closed` fires before before-quit, so `persistCallsForQuit` found no live
call either), and every skip being invisible (the event only fired when the
model was called). Now:
- The Stardew and DST runtimes pass `{ endReason: 'world_closed' }` for a
  live world that closed (as Minecraft does), so the check runs.
- `src/main/nextStepReach.ts` (pure, tested) routes each end:
  `gameEndRoute` (check / persist for the next launch / goodbye /
  not_covered) and `mainClosedCallRoute` (window close: check now on macOS,
  persist elsewhere; app quit: already persisted; account switch, renderer
  gone or reload: not_covered). `endCallsForAccountSwitch` hands each closed
  call to `onClosed` for this.
- `next_step_checked` goes out once per session end on every surface, with
  `reached_model` and `duration_s`. Check outcomes: saved, none, trivial,
  offline, over_limit, busy (dedupe), timeout, error, no_character
  (cancelled still sends nothing). Ends that ran no check
  (`reportNextStepNotRun`): goodbye (`saved` = it left a plan), in_game (a
  call during a game), deferred / trivial (app quit, run or not on the next
  launch), not_covered + `end_reason` (backseat ends other than the player's
  End, game kicks / crashes / credit stops, chat idle / quit, chess, Draw!).
  Count checks with `reached_model = true` to compare with older data.
- A companion goodbye plan also sends `next_step_saved {source:'companion'}`,
  so `next_step_saved` counts every plan source.
Not covered, by choice: chess and Draw! (a check there would be a new LLM
call for free users), DST final death, companion goodbyes without a plan, and
calls lost to an account switch or a renderer crash.

**Text chat gets the check when it costs Sei nothing (261107, O2).** The chat
memory fold (`continuity.ts`) is not a session-end call: it runs per 50-message
batch and never sees the newest 50, so it cannot carry the plan. Instead
`src/main/chatNextStep.ts` runs the same player-end check on a chat end, with
`surface: 'chat'`, activity `a text chat`, lines = the typed transcript rows
in the session window (`chatDigestFromRows`), and two extra input gates:
`minPlayerLines` 4 (`CHAT_MIN_PLAYER_MESSAGES`) and `skipOnFreeCloud`. The
gate (`PlayerEndDeps.freeCloud`) passes BYOK, Ollama and other local models,
the ChatGPT plan, and paid plans (quest / party spend their own allowance);
the cloud free plan, signed out, or a plan read that fails or takes over 5 s
is skipped and reported as `outcome: 'not_covered', skip_reason:
'free_cloud'`. Routing (`chatEndRoute`): idle end = check in the background
(endChatSession never waits on it); quit = `PENDING_NEXT_STEP.json` with
surface `chat`, checked on the next launch through the same gate; account
switch = not_covered. A new chat session yields a local-model check. Plans
about a game are tagged with that game; others are tagged `chat`, and the
Home card's button is "Message {name}" (opens the chat). Probe:
`npx tsx scripts/chat-next-step-probe.ts --reps 3` (16 chats, 261107: saved
17 of 24 on chats with a plan, 0 of 24 on small talk; misses were "ask how X
went" chats). Not done: a chat plan is not marked used by the next chat.

**Forge/NeoForge hosts are blocked before summon (260929).** Only on STRONG
evidence: the status ping's forgeData/modinfo (`forgeModCount != null`) or an
explicit launch target on the host command line (`LanHost.forgeLaunchTarget`,
`hasForgeLaunchTarget()` in hostClient.ts). Forge classified from a weak
cmdline substring alone gets the soft `'modded'` warning so a misread never
locks anyone out. The one check is `forgeHostBlock()` in `src/shared/ipc.ts`,
used by all three entry points: the Summon button (`lanHostWarning() ===
'forge'` opens the blocking `LanHostWarningModal`, no "Summon anyway"), the
chat `launch()` tool (`resolveLaunch` returns a relayable note and never
summons) and the supervisor pre-gate (error `FORGE_HOST_BLOCKED`, backstop for
the voice launch honors; `SEI_FORGE_HANDSHAKE=1` bypasses it). Each refused
attempt is counted exactly once. The button and the `launch()` tool fire
**`summon_blocked`** (`character_id`, `game`, `reason: 'FORGE_HOST_BLOCKED'`,
`loader`, `host_client`, `path`: `button` / `chat` / `voice`, props built by
`summonBlockedProps()` in shared/ipc.ts; the tool fires at most one per turn),
and neither reaches the supervisor. A refusal at the supervisor pre-gate (the
voice idle/react launch honors, or a stale renderer host) fires only the
existing `summon_failed` with `summon_phase: 'pre_gate'` and `reason:
'FORGE_HOST_BLOCKED'`. All Forge attempts = `summon_blocked` + that
`summon_failed` slice. The retry guard
block for that class is released as soon as the LAN host stops being a blocked
Forge host. Quilt and Fabric with foreign mods keep the soft `'modded'`
warning. A join TIMEOUT (ready phase, or the bot's connect guard) on a
Forge-family host (`isForgeFamilyLanHost()`: Forge/NeoForge on any evidence,
or an unclassified host with Forge ping data) is reported as
`MODDED_HOST_REJECTED` with `reclassified_from: 'BOT_START_TIMEOUT'` on
`summon_failed`, so the player gets ModdedHostModal instead of generic timeout
copy. Timeouts on Fabric with foreign mods and on Quilt stay plain
`BOT_START_TIMEOUT`: those hosts often do let a vanilla client in. `character_summoned` carries `host_client`.

**Online-mode and Fabric kicks (261007).** A plain Open to LAN world lets
an offline client in (the integrated server logs "Failed to verify username
but will let them in anyway"), so a `multiplayer.disconnect.unverified_username`
kick means a server with online-mode on or a mod that enforces it. connect.js
`isOnlineModeRejection` flags it, and runtime.js fails on the FIRST kick as
`ONLINE_MODE_REJECTED` (kick_code `unverified_username`), routed to the
generic game-error popup with the server.properties / LAN-mod fix. It used to
retry three times and end as LAN_NOT_OPEN. The Fabric API registry-sync kick
("requires Fabric Loader and Fabric API ... namespaces may be related") is
humanized as Fabric, not Forge, and names the mods (`fabricKickNamespaces`);
ModdedHostModal reads both back from the status message. Xaero's Minimap and
World Map were the named mods in both 0.6.7 cases, so no copy may call
minimaps safe.

**Text chat counts too (260801).** Chat was the last surface with no
instrumentation at all, so playtime meant "everything except the thing people
do most" and a user who only ever texted had an empty character list on the
dashboard. `src/main/chat/chatSession.ts` models a session as a run of messages
closed by a 5 minute idle gap, NOT as ChatScreen mount/unmount: a chat window
left open in the background is not playtime, and the chat screen HOSTS the
other surfaces, so mounted time would double-count every chess game, Draw!
round and call against the chat clock. The overlap is excluded structurally —
`noteChatMessage` is called from exactly one place in the `chat:send` handler,
past the point where chess and Draw! have declined the message and with
`inCall` false, so a line typed into a live game or spoken on a call is only
ever counted by that surface. `duration_ms` spans first message to LAST
message, never the idle tail, so a one-message session honestly reports 0 ms
and `messages` carries the shape. `endAllChatSessions()` runs on `before-quit`
BEFORE `shutdownAnalytics()`, because quitting mid-conversation is the normal
way a chat ends.

**`reply_latency`: how long the player waits for a reply (261106, retention
O2 item 6).** One event per SAMPLED player turn, props `{surface: chat|voice|
minecraft, path: app|in_game, ms, outcome: replied|silent|error|aborted,
turn_index_bucket: first|2-5|6+, sample_rate: 1|10, via?: say|action}`
(`via` on minecraft only; `backend` / `ai_provider` come from commonProps).
`ms` is raw, like every other duration. Sampling lives in ONE place,
`src/main/replyLatency.ts`: turns 1-5 of a session always, then only every
tenth turn (10, 20, ...) with `sample_rate: 10`, so each bucket has a single
rate and per-bucket percentiles need no weighting. Sampled per turn rather
than rolled up per session on purpose: percentiles do not merge across
sessions, and a roll-up is lost when a session never closes cleanly. Clocks:
- chat (main, `chat:send` in ipc.ts, at the `noteChatMessage` choke point,
  turn = the chat session's message number): handler entry to the first
  companion bubble handed to the renderer (the early line before a web lookup
  via `emitReply`, else the returned reply). Empty replies = silent,
  `CHAT_ABORTED` = aborted, a rejection = error. Realistic-typing pacing is
  not included. A routed send records nothing here; the bot times it.
- voice (renderer, `lib/voice/replyClock.ts`, wired in `useVoiceStore`):
  `dispatchUserTurn` (the STT final) to the audio queue's `onAudible`. Turn =
  utterance number in the call. A new utterance or hang-up before audio =
  aborted; all off-game sends returned with nothing queued (plus a 1.5 s IPC
  grace) = silent; the director exhausting its retries, or a queued line that
  never played by the 45 s give-up timer = error; nothing at all by then =
  silent. Sent via `sei.track('reply_latency', ...)`; main's analytics:track
  handler rebuilds it from closed enums (`sanitizeRendererReplyLatency`) and
  samples it. Typed mid-call messages are not timed on any surface.
- minecraft (bot, `brain/actionStats.js`, minecraft sessions only): a timed
  player line (`notePlayerChat`) to the say() or started world action that
  answers it (same events as the existing `reply_ms_total`, decision time,
  not the paced send). Unanswered after `UNANSWERED_MS` (20 s) = silent, or
  error when an LLM error came after the line; a line still waiting at a
  terminal lifecycle = aborted (`abandonPending`). Posted per turn as
  `{type:'reply-latency', origin, turn, ms, outcome, via}`; botSupervisor
  re-validates it (`parseBotReplyLatency`). `origin: 'app'` (a Sei chat
  routed in by `deliverSeiChat`) is reported as surface `chat`, path
  `in_game`; voice lines reaching the bot are not timed there (the voice
  clock owns calls).
No model call and no tokens are added; dev launches send nothing (the
initAnalytics channel gate).

**Every event carries `ui_language` (260801).** `commonProps()` in
`src/main/analytics.ts` stamps the APP UI language (not the per-character
`chat_language`) on every event and `$set`s it on the person. Before this the
only cloud-side trace of a non-English user was `characters.metadata.language`,
which is written at character CREATION — so anyone using only the bundled
defaults was invisible. Cached, not read per event (commonProps is sync);
`setUiLanguage()` is refreshed from the `config:save` IPC handler, the single
path both Settings and the onboarding Sui stage write it through.

**Build, device and provider facts on every event; dev builds send nothing
(261031, T278).** `commonProps()` also stamps `channel` (`stable`/`beta`/
`test`/`dev`), `packaged`, `device_id`, `rollout_bucket`, `$session_id` (a
UUIDv7 per process), `ai_provider` (`cloud`/`chatgpt`/`byok`/`ollama`/`unset`),
`llm_provider`, `model_family` (closed enum, never the model name) and `plan`
(`free`/`quest`/`party`, `none` signed out, `unknown` before the first credits
read). Rules in `src/main/analyticsContext.ts` (pure, tested):
- The channel is baked: release.yml exports `SEI_RELEASE_CHANNEL=sei-channel=
  stable|beta` on a tag build only (and fails the build if `dist/main` lacks
  it); `electron.vite.config.ts` defines it. Unpackaged = `dev`; any other
  packaged build (local `dist:*`, spike or dry-run workflows) = `test`; a
  prerelease version can never read `stable`.
- **Send gate:** `initAnalytics` creates no client unless the channel is
  stable or beta, or `SEI_ANALYTICS_DEV=1` is set at runtime. Tests that need a
  live (mocked) client set it in `vi.hoisted`.
- **Identity model (reworked after review).** `distinct_id` = the Supabase
  user id when signed in; else the profile's EXISTING `analytics_install_id`
  (every install from before 261031); else `device_id`, a salted sha256 of the
  device-global `device-id.json` id (never the raw id: it gates trials). A new
  install id is minted only when the device id cannot be read. `device_id`
  rides on every event as a property, whatever the distinct id. Nothing is
  aliased at init. Sign-in (`identifyUser`) sends `alias(user <- anonymous
  id)` then `identify(user)`, the pre-261031 flow. Rules PostHog enforces and
  this keeps: the anonymous id is only ever alias()'s `alias` argument, never
  its `distinctId` and never identified, so its person stays unidentified and
  merges into the account's person, new or existing. An id that was alias()'s
  `distinctId` cannot later be an alias, and an identified person never merges
  into another: the first 261031 draft aliased `device <- install` at init,
  which identified the device person and orphaned day-0 events
  (`installer_first_launch`, onboarding) from every later sign-in to an
  existing account. A second account on one device: `<userData>/
  analytics-identity.json` records which account each anonymous id was merged
  into, and a different account gets `identify` only, because aliasing an
  already-merged id into a NEW account adds that account to the first one's
  person. Sequences are asserted against a model of PostHog's merge rules in
  `analytics.identity.test.ts`; `scripts/posthog-identity-check.mjs` replays
  them against a SCRATCH project by hand (refuses the prod key).
- `checkout_completed {kind: subscription|upgrade|topup, tier, from_tier,
  credits_added?, checkout_opened_this_session}` fires when two credits
  snapshots of the same account in a row show a higher tier or more top-up
  credits (`notePlanSnapshot`, fed by `proxyClient.creditsGet`). It is what the
  app learned, not the payment; Supabase ledger stays the source of truth. A
  tier rise out of `past_due`/`unpaid` is a recovered payment (entitled_tier
  reads free while it fails) and does not count; each read carries a `seq`
  taken before its network call, and a read older than one already applied is
  dropped.
  `plan_changed` fires on a successful change only.
- Watch together: `backseat_started`/`_ended` carry `game` (the tile id, or a
  game matched from the shared window title against the closed list in
  `backseat/watchedGame.ts`, `game_source: tile|title`) and `watched_kind`
  (`game`/`video`/`browser`/`other`/`unknown`). The title never ships.
- `summon_failed` carries `game`, and redact() also scrubs the player's own
  `mc_username` / `preferred_name` (`RedactOptions.playerNames`).

**Crash reporting (261031, T278, `src/main/crashReporting.ts`).** No Sentry,
no minidump upload. `initCrashReporting()` runs first in whenReady:
- `<userData>/session.json` is written `open` at launch (heartbeat every 60s,
  plus the surface in use and a hung-window flag), `closing` at before-quit,
  `closed` at `quit` (after index.ts's teardown, which ends in app.exit(0)),
  `os_shutdown` on Windows `session-end` or powerMonitor `shutdown`, and
  `start_failed` when bootstrap threw (`markStartFailed()` before app.exit(1);
  a nonzero `quit` exit code records it too) or the boot guard judged the
  start failed (see "Crash analytics seam" under Boot safety). The next launch reads it before
  writing its own: `open` = `unclean`, `closing` = `quit_hang` (the teardown
  hung and was killed), `start_failed` = `start_failed`; all three send
  `app_unclean_exit {prev_exit, prev_session_id, prev_version, prev_channel,
  prev_uptime_ms, prev_surface, prev_renderer_unresponsive, prev_crash_kind,
  prev_quit_wait_ms (quit_hang)}`, so crashfree.mjs counts them. `app_opened`
  carries `prev_exit` (`clean`/`unclean`/`quit_hang`/`start_failed`/
  `os_shutdown`/`none`) and `prev_version`. Do NOT add session.json to
  `PRIOR_STATE_ENTRIES`: it exists before noteLaunch on a fresh install. The
  skin and auth-loopback servers stop through `stopHttpServer` (idle
  keep-alive sockets closed, everything destroyed after 3 s), so a socket can
  no longer hold the quit open.
- `app_crash {kind: main_uncaught|renderer_gone|child_gone, process_type,
  reason, exit_code, page, service, error_name, fingerprint, top_frame,
  surface, uptime_ms}`, `app_error` (main unhandled rejection, same shape) and
  `app_hang {page, duration_ms, recovered}` (window `unresponsive` until
  `responsive` or closed). Once per signature, at most 20 per process.
  Companion-bot exits are left to `summon_failed`/`bot_session_failed`.
  Installing the process handlers replaces Electron's error dialog: the app
  keeps running, as it did after the dialog.
- `<userData>/logs/crash/crash.log` holds the scrubbed message + stack
  (`crashLog.ts`, redact() + the player's names), rotated to `crash.1.log` at
  256 KB, 8 KB per entry, 5 repeats per signature. A subdirectory, so
  `pruneLogsDir` never deletes it. Events carry no message or stack text.
- Crash-free sessions per version: `~/suisei/reports/retention-2026-10-05-
  queries/crashfree.mjs`.

**`installer_first_launch` fires once per install (260926).** It carries
`platform`, `arch`, `os_version`, `packaged`, `arm64_translation`, and on macOS
`in_applications`, `translocated` and a coarse `app_location` enum
(`applications`/`translocated`/`volume`/`downloads`/`other`, never a path).
"Once" is the device-global `<userData>/install-marker.json`, created with an
exclusive open by `noteLaunch()` as the FIRST step of `bootstrap()`
(`src/main/firstLaunch.ts`). It cannot key on `analytics_install_id`: that id
lives in the profile-scoped config, so a first sign-in would mint a new one.
The marker step also probes for older Sei state (`PRIOR_STATE_ENTRIES`), so an
existing install updating to the first build with this code is classified
`upgrade` and sends nothing. Keep that list in sync if a new device-global
file appears, and keep `noteLaunch()` ahead of anything that writes userData.

**Retention events (261005).** From the retention analysis
(`~/suisei/reports/retention-2026-10-05.md`):
- `credit_wall_hit` (`src/main/creditWall.ts`) fires from `emitCreditsHardStop`
  (every popup path: chat, voice, chess, Draw!, backseat via
  `raiseUsageLimitPopup(err, surface)`, the bot's pre-flight gate and
  mid-session walls via the supervisor) and from the proxy-route TTS/STT 402s,
  which never raise the popup. One event per wall: keyed by `reason`, a burst
  collapses while repeats are under 10 minutes apart. A new hard-stop path
  passes its `CreditWallContext`. `allowance_used_micro` is `usage_pct` of the
  plan allowance (1% resolution; the client cannot read the ledger sum).
  `credit_wall_action {action, reason, ms_open}` is the modal's answer
  (`close | topup | upgrade | chatgpt | own_key`).
- **Free ways past the wall (261103, T307).** On a free plan at a credit wall
  (not a rate limit, not a subscriber) HardStopModal adds "Keep playing free"
  under Top up / Upgrade (`wallFreeOptions`, pure): "Use your ChatGPT plan"
  runs `startChatgptPlan()` (`lib/popupActions.ts`, the SAME flow and
  in-flight latch as the popup `chatgpt-plan` action; a busy latch falls back
  to Settings at the plan row), and "Use your own API key or a local model"
  opens Settings at the Backend row (`view.focus: 'ai-backend'`, the
  `data-settings-focus` marker, else the local Provider row). Both dismiss
  the popup first. The ChatGPT option is hidden when it is already the
  provider in use. It is never hidden by region: like the Settings plan
  row, the provider decides (261103).
  Verify with `?dashshot=creditwall&part=modal` (+`&gpt=active`,
  `&theme=light|dark`, `&lang=zh`).
- `onboarding_step {step, index, action: view|complete|skip|back, ms_in_step,
  path, skipped_creation}` per OnboardApp screen (`onboard/onboardSteps.ts`;
  not the boot sign-in variant). A new screen or button that skips needs a
  step name in `ONBOARD_STEPS` and, for a skip, `markStep('skip')`.
  The intro step's closing event carries `intro_advanced_by`
  (`transition | watchdog | skip | reduced_motion`), `intro_watchdog_stage`
  and `intro_hidden_at_start`; a watchdog on a later scene stage (walk-off,
  send-off walk-in) adds `scene_watchdog` to the step it closes
  (`tracker.annotate`, 261012).
- **The onboarding scene never waits on `transitionend` alone (261012).**
  8 of 42 fresh v0.6.8 first launches never left the intro: its four stages
  (ground in, Sui in, Sui out, ground out) advanced only on CSS
  `transitionend`, with no timer and no button. Each stage is now a gate
  (`onboard/sceneGate.ts`, armed in `OnboardScene`) that completes exactly
  once on transitionend, a watchdog at `max(css + 1.5 s, 3 s)`, a click or
  key during the intro (skip), or at once under `prefers-reduced-motion`. A
  hidden window holds the first slide and the watchdog until it is shown,
  bounded by `HIDDEN_CEILING_MS`. The CSS durations are mirrored as
  constants in `OnboardScene.tsx` (a test checks). Verify in a tab with
  `?dashshot=onboard` (track calls land on `window.__seiDevTrack`).
  `onboarding_abandoned` comes from the renderer on unmount (`left_view`) and
  from main at quit / last-window-close (`src/main/onboardingFunnel.ts`, fed
  by the analytics:track handler).
- `onboarding_completed {path: new|skip|byok|existing|returning}` fires once,
  at the config save that writes `preferred_name` (not after generation) and
  on the welcome-existing and returning completions. Events captured before
  `initAnalytics()` resolves are queued and replayed (`analytics.ts`); they
  used to be dropped.
- `app_quit {session_ms, last_surface}` first in before-quit; chess, Draw! and
  backseat now end (reason `app_quit`) BEFORE the flush.
- `update_installed {from, to, via}` from `runWhatsNewCheck`.
- `backend` reads `'unset'` until the profile has a `preferred_name` on the
  default `local` kind.

### The play row is ONE sentence, shared (260728)

`src/main/chat/playSummary.ts` owns it, and every game surface calls it:

```
You and Marv played Draw! for 7 minutes.
```

No results, no score, no move count, no window name. Each surface used to
compose its own, and read back in the chat log that was four registers for the
same event, with the detail aging worst: a scoreline from four days ago is the
least interesting thing about having played. `playSummaryText(name, game, ms)`
is the only way to write one, and `playSummary.test.ts` pins the shape.

This is also what the character reads later through the rolling summary, so
dropping results is a deliberate trade: the companion remembers the SESSION
rather than the scoreline. Anything genuinely worth keeping is what
`remember()` is for, and every surface already offers it.

### Setup telemetry: `game_setup_step` (261104)

Neither the Minecraft nor the Stardew setup sent anything before this, so
the 30% of new users whose Minecraft scan found no Java install and every
Stardew SMAPI failure were invisible. One shape-only event,
`game_setup_step`: `game` (minecraft | stardew), `step`, `outcome`
(start | ok | fail), `error_code` (UPPER_SNAKE, always set on a fail),
`store` (Stardew store or Minecraft launcher kind), plus closed extras:
`reason` (network / permission / locked / antivirus / game_running /
timeout / disk_full / not_found / java / cancelled / other, read from the
error message, which never leaves), `found`, `launchers`, `bedrock`,
`ended`, `wait_ms`, `version_ok`. `os` and `app_version` come from
commonProps. The builder (`setupStepProps`, `src/shared/setupTelemetry.ts`)
drops anything outside the enums, and main rebuilds renderer-sent copies in
the analytics:track handler, so no path, username or free text can ride.

- Minecraft steps: `install_scan` (once per distinct answer: java /
  other_launcher / bedrock_only / launcher_only / none), `wizard` and its
  stages `fabric`, `mods_link`, `skin_mod`, `config` (folded from the
  wizard progress stream, `observeWizardProgress`), `start_minecraft`,
  `open_launcher`, `lan_wait` (McSetupModal searching mode; `ended`:
  world_open / closed / skin_setup / left).
- Stardew steps: `find_game` (scan, once per distinct answer),
  `choose_folder`, `smapi_download`, `smapi_run`, `mod_copy`, `mod_silent`
  (game up 15 s with the helper silent), `farm_seen` (first open farm per
  process).
