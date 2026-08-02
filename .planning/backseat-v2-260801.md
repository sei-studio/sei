# Backseat v2: scheduled wake, log-spaced grid, real gain/colour signals

Branch: `v0.5-backseat`, worktree `.claude/worktrees/v0.5-backseat`
Date: 260801. Supersedes `.planning/backseat-redesign-260731.md` (kept for the Stage 0 measurements, marked superseded).

---

## Context

The 260731 plan tried to solve "when should the companion talk" with a small VLM:
first as a yes/no salience gate, then as a narrator whose narrations would be
compared for novelty. Stage 0 measured that idea end to end on real Valorant
footage and it failed. Against its own resampling ceiling (0.749) and an
unrelated-grid floor (0.623), narrations three seconds apart scored 0.660: real
temporal signal of 0.037 against 0.25 of pure resampling noise. The structured
variant was no better where it mattered, and `static: true` came back on 0 of 61
grids, the same yes-bias the salience gate already had. Prose, prose+labels,
multi-image and structured were all measured. None separate.

So the small VLM is being removed rather than repaired. What replaces it is not
another model, it is a schedule: the companion looks up every few minutes on its
own, and otherwise only when something local and cheap says to look. That is
simpler than what exists today, not more complex.

The other half of the 260731 plan survives unchanged because it was validated,
not rejected: **log-spaced frames**. The clip's own HUD proved it. One grid's
round timer reads 1:13 / 1:10 / 1:08 / 1:07 / 1:07 / 1:07 across the six cells,
matching the 3.0 / 1.5 / 0.75 / sub-second offsets exactly, and another grid's
ammo counter reads 5 / 1 / 6 / 6 / 5 / 4, resolving fire-through-cover into
reload-in-smoke into emerge, spot, aim, fire across three distinct states inside
the final 600 ms. Under today's 1 Hz sampling that whole engagement is one frame.

**Intended outcome.** Three wake sources, each with its own opening line to the
model, in a strict priority order that can interrupt: player message, then a
sudden gain or colour change, then a randomised idle timer. Frames sampled so
that "dodged then fired" is actually visible. Every one of those looks is a full
Haiku call with a 1548-token image, at a mean cadence near 30 s, so the cache
layout stops being hygiene and becomes the cost model. And a way to review all
of it offline: the Valorant clip run through the real pipeline to produce a
voice-over.

---

## Approach

Six steps. Steps 1-4 are code, step 5 is measurement, step 6 is the review
artefact. Nothing here adds a model call that does not become speech.

### 1. Log-spaced frames

`src/shared/backseatIpc.ts` gains the offset table and the sample rate:

```ts
export const GRID_OFFSETS_S = [6.0, 3.0, 1.5, 0.75, 0.375, 0.1875];
export const SAMPLE_INTERVAL_MS = 100;   // 10 Hz, uniform
```

`captureWorker.ts` loses its argmax and its one-second buckets. Today it keeps
one JPEG per second, chosen by whichever frame in that second had the loudest
audio, which is why consecutive cells land anywhere from 40 ms to 1.9 s apart
while `backseatPrompts.ts:51` tells the model they are "about a second apart".
That selection rule is the direct cause of the no-sense-of-sequence problem and
it goes away entirely.

In its place, one uniform ring: encode a cell-sized JPEG every 100 ms and keep
`BUFFER_MS` (9 s) of them. That is 90 entries at roughly 35 KB, about 3 MB
resident, and 10 encodes per second instead of 1. A tiered scheme (bitmaps for
the recent tier, JPEGs for the old) was considered and rejected: it holds
~18 MB of `ImageBitmap` to save ~8 encodes/second of a 602x336 JPEG, which is
the wrong trade and two code paths instead of one.

`composite()` then resolves each offset to the nearest sample. At 10 Hz the
placement error is at most 50 ms, and the tightest gap in the table (0.375 to
0.1875) is 187 ms, so every cell is distinguishable. A cell with no sample
within 500 ms of its target stays black, the existing honest-hole behaviour, so
a session younger than six seconds shows real gaps rather than a compacted
sequence that silently lies about the timeline.

The grid geometry does not move: still 6 frames, still 1204x1008, so
`backseatIpc.test.ts`'s 1548-token Haiku assertion stands untouched.

`BACKSEAT_CONTRACT` is rewritten to state the truth: the gaps are uneven and
halve toward the present, the top row covers the last six seconds, and the
bottom row is all inside the final second. That last sentence is itself a
useful hint that the recent cells are where the action is.

**Files:** `src/shared/backseatIpc.ts`, `captureWorker.ts`, `backseatPrompts.ts`.

### 2. Remove the small VLM, add the scheduled wake

**Removal.** Delete the wiring, park the module. `salienceGate.ts` and
`salienceGate.test.ts` stay in the tree with a header note saying they are
parked and nothing calls them, because "disable it" is what was asked for and a
file nothing imports costs nothing. What goes is every call site: the
`GATE_INTERVAL_MS` timer in `captureController.ts:558`, `askGate` in
`backseatService.ts:311`, the `backseatGate` IPC handler, its preload binding,
and its `shared/ipc.ts` type. Eight touch points, all found by grep.

**The idle wake.** A self-rescheduling timer in `captureController.ts` that
composites a grid and sends an `idle` tick. In `backseatIpc.ts`:

```ts
export const IDLE_MIN_MS = 12_000;         // the floor
export const IDLE_MEAN_EXTRA_MS = 16_000;
export const IDLE_MAX_MS = 60_000;         // the ceiling

/** Shifted exponential, clamped. */
export function nextIdleDelayMs(rand: () => number = Math.random): number {
  return Math.min(IDLE_MIN_MS + -Math.log(1 - rand()) * IDLE_MEAN_EXTRA_MS, IDLE_MAX_MS);
}
```

On the open distribution question: **shifted exponential**, not uniform. After
the floor the hazard rate is constant, which is the formal way of saying the
wait is memoryless and the player cannot learn to anticipate it. Uniform on
[12, 60] has the opposite property, a wait that becomes *more* likely the longer
it has already gone on, which is exactly the metronome feel to avoid. Mean lands
near 28 s; 5 % of draws clamp at the 60 s ceiling. All three constants are
independent, so switching to uniform later is one line.

At this cadence the idle timer is the dominant source, roughly 130 looks an
hour, which is why step 4 exists. It is also why `MIN_SPEAK_GAP_MS` (8 s) and
`JOLT_REFRACTORY_MS` (20 s) stay exactly where they are: with a 12 s floor they
are now doing real work rather than sitting unreachable behind a slower gate.

**The timer resets whenever the companion speaks, from any source.** Without
that, an idle tick can land ten seconds after a colour jolt already produced a
line about the same moment. `BackseatOverlay.tsx:84` already subscribes to
`sei.onBackseatLine`, so this is a `capture.current?.noteSpoke()` call in a
handler that exists.

**Priority.** `BackseatTickKind` becomes `'user' | 'jolt' | 'idle'` (a rename of
`'gate'`; `jolt` keeps its `joltReason: 'gain' | 'color'`). `handleTick` in
`backseatService.ts:403` currently hardcodes "user preempts, everything else
drops". It becomes a ladder:

```ts
const PRIORITY = { user: 3, jolt: 2, idle: 1 } as const;
```

A tick aborts an in-flight turn when its priority is strictly higher, and is
dropped otherwise. Never queued: a queued reaction arrives describing a moment
that has passed, which reads as confusion rather than lateness.
`MIN_SPEAK_GAP_MS` still gates `jolt` and `idle` and still does not gate `user`.

**Per-kind opening lines.** `tickNote()` (`backseatPrompts.ts:110`) already
switches on kind, so this is a rewrite of three branches, in the requested
wording:

- `idle` — you are watching their stream, nothing in particular set this off,
  see whether something worth reacting to happened; if it did, say what you
  think; if it did not, reply with exactly (silence).
- `jolt` — something may have just changed on the screen (the sound spiked /
  the picture changed a lot), see what is happening; it may be nothing, and
  staying quiet is fine if it was.
- `user` — the player just said this and here is what was on screen, answer them.

One thing in `BACKSEAT_CONTRACT` has to move with this. Its "WHEN TO SAY
NOTHING" paragraph currently claims "you are only shown the screen when
something probably DID just happen, so most looks deserve a line". That was true
of a gated tick and is false of an idle one. It gets rewritten to say the bar
for speaking is set by the per-tick note, which is precisely the split being
asked for. The 260728 warning is respected: the contract does not sanction
silence as a general mood, it defers to the note, and only the `idle` note sets
a high bar.

**Files:** `src/shared/backseatIpc.ts`, `captureController.ts`,
`backseatService.ts`, `backseatPrompts.ts`, `src/main/ipc.ts`,
`src/preload/index.ts`, `src/shared/ipc.ts`, `BackseatOverlay.tsx`.

### 3. Fix the cache layout for an image-per-tick surface

Backseat already does the two things every surface does: `BACKSEAT_CONTRACT`
rides in `extraStable` so it sits inside the cached system region, and
`markLastMessageCached(messages)` puts a breakpoint on the message tail. On a
surface whose every turn carries a fresh 1548-token image, the second of those
is **backwards**, and at a 12-60 s cadence it is worth fixing.

`buildSystemBlocks` spends three of Anthropic's four breakpoints (persona, last
stable block, status). `markLastMessageCached` spends the fourth. In
`backseatService.runTurn:518-531` the last message is the one that carries the
image and the per-tick note, and both are unique to that tick forever. So the
fourth breakpoint writes ~1630 tokens at the 1.25x write multiplier on every
single tick and can never read a single one of them back. Meanwhile the thing
that *is* stable turn to turn, the twelve history messages between the system
blocks and the image, sits under no breakpoint at all and is re-billed at full
price every tick.

Two changes, both local to `runTurn`:

- **Move the fourth breakpoint off the image message and onto the last history
  message.** The image and the note then sit after every breakpoint: plain input
  tokens, written nowhere. System plus history becomes a cache read on each
  tick. `markLastMessageCached` is not the right helper for this, so backseat
  calls a sibling that marks a given index; the existing helper keeps its
  meaning for chat and voice, where the last message genuinely does repeat.
- **Anchor the history window instead of sliding it.** `history.slice(-RECENT_CAP)`
  (`backseatService.ts:508`) drops its oldest message every time a line is
  appended, which changes message[0] and invalidates the entire message prefix.
  Holding a per-session start index and only re-anchoring when the window has
  grown to `2 * RECENT_CAP` turns a guaranteed miss on every spoken line into
  one miss per twelve lines. This is the same trick the Minecraft brain uses
  with its `cachedSystemBlocks` identity (`src/bot/brain/orchestrator.js:4506`):
  the value of a breakpoint is entirely in whether the bytes above it are
  byte-identical next time.

Deliberately **not** doing two things. Not raising the TTL to 1h: writes cost
2x there, and a 12-60 s cadence with a refresh on every read never approaches
the 5-minute default's expiry. And not caching the images themselves by keeping
past ticks in the array: that grows the prompt by 1548 tokens per tick to cache
pixels the model has already reacted to.

The evidence that this worked is `usage.cache_read_input_tokens` versus
`cache_creation_input_tokens`, which the sim in step 6 already has in hand from
every response and will report per tick. That is the same live-capture method
the 260706 comment in `chatPrompts.ts:311` used.

**Files:** `backseatService.ts`, `src/main/chat/chatPrompts.ts` (one new helper).

### 4. Extract the signal kernels

With the gate gone, gain and colour are the only thing that puts a look *on the
moment it matters* rather than up to a minute later. They have to actually fire,
and right now there is no evidence either ever has.

The arithmetic moves out of the worker into
`src/renderer/src/lib/backseat/signals.ts`, pure functions over explicit state,
matching the `pcm.ts` / `transcriptRing.ts` convention already in that folder:
`thumbDelta`, the rolling median/MAD baselines, and one `decideJolt(state, now)`
that returns `'gain' | 'color' | null`. `captureWorker.ts` keeps the canvases and
the frame loop and calls into it.

This is not tidying. It is what lets step 5 run the *same code* over the clip
offline instead of a re-implementation that could agree with the app or not.

### 5. Measure and retune gain and colour on the clip

New `scripts/backseat-sim.ts`, run under the repo's existing `tsx` devDep so it
imports the real `signals.ts`, the real `GRID_OFFSETS_S`, and the real prompts
rather than copies. It replaces `scripts/backseat-lab.mjs`, which was built for
the narration experiment and has served its purpose.

`ffmpeg` (already at `/opt/homebrew/bin/ffmpeg`) is asked for three things off
`~/Downloads/valorant-clips.mp4`, which is 1280x720 at 60 fps with audio, an
exact match for `CAPTURE_W/H/FPS`, so the sim's grids are pixel-identical to the
real worker's:

1. cell-sized JPEGs at 10 Hz, the frame bank,
2. 32x18 rgb24 raw at 10 Hz, the thumbnails the colour arm reads,
3. 16 kHz mono PCM, from which per-32 ms RMS dBFS is computed with the real
   `rmsDb` from `pcm.ts`.

`--dry` then walks a virtual clock in 100 ms steps, feeds the real detector, and
prints every gain and colour candidate with its timestamp and score plus the
full per-step distribution. No model calls, so threshold tuning is free and
instant.

**Order of work here matters and is deliberate.** I run `--dry` with the current
thresholds first and report what fires. My expectation, stated so it can be
proved wrong: `JOLT_GAIN_DB = 18` over a trailing median never fires in Valorant,
because continuous gunfire and music hold the median high, and
`JOLT_COLOR_DELTA = 0.34` on a *mean over the whole 32x18 thumbnail* rarely
fires, because averaging over the frame is exactly what erases a localised
event. Then, rather than asking for labels up front, I bring back a timestamped
candidate list and ask which are real firing and which are real room changes.
Confirmed events become the target the thresholds are tuned against.

Two changes are pre-loaded as the likely fix, both from the 260731 analysis, and
both applied only if the measurement says they are needed:

- **MAD-relative thresholds** replacing the absolute 18 dB and 0.34, so a loud
  game and a quiet game behave alike. This is the direct answer to "absolute
  colour change is hard".
- **Block-max over a 4x3 split** of the thumbnail instead of a global mean, for
  the colour arm. Averaging is what makes a kill feed or a hit marker invisible
  at any threshold; taking the max over twelve blocks makes a localised change
  visible and additionally reports *where*.

Whether both, one, or neither is needed is a measurement, not an assumption.

### 6. The voice-over

The same script without `--dry` runs the whole clip: idle timer on a seeded RNG
(so a run is reproducible), gain and colour from the tuned detector, the real
priority ladder, the real `BACKSEAT_CONTRACT` and `tickNote`, and a real Haiku
call per wake. Output:

- `voiceover.md` — `[01:23] color -> "..."` per line, silences included as
  `(silence)` so the misses are as visible as the hits,
- `voiceover.json` — the same with signal scores and the actual frame offsets
  achieved per tick,
- `grids/tick-NN.jpg` — every grid the model saw, so a line that reads wrong can
  be traced to the pixels that caused it,
- `signals.csv` — gain and colour per 100 ms, so thresholds can be re-tuned
  without re-running the model,
- per-tick `cache_read` / `cache_creation` token counts, which is how step 3 is
  proved rather than asserted.

The clip is 3:07, which at a mean 28 s idle cadence is six to eight idle wakes
plus whatever gain and colour raise. Enough to read as a voice-over and to see
whether the priority ladder is interrupting in the right places.

**One honest deviation.** The sim uses a fixed stub persona instead of
`buildSystemBlocks`, which needs a real character, config and Electron paths.
The contract, the notes, the grid and the model are real; the persona is not.
That makes the voice-over a fair test of timing, of the grid, and of the wake
sources, and not a test of how any particular companion sounds.

---

## Verification

- **`npm test`** — new unit tests for `nextIdleDelayMs` (bounds, and that the
  mean sits where claimed over 10k draws), the offset-to-sample resolver,
  `thumbDelta` / the block-max variant, and one asserting the tick message
  carries no `cache_control` while the last history message does.
  `backseatIpc.test.ts` must pass unchanged; it pins the 1548-token budget.
  `salienceGate.test.ts` keeps passing against its parked module.
- **`npx tsx scripts/backseat-sim.ts --dry`** — the threshold loop for step 5.
- **`npx tsx scripts/backseat-sim.ts`** — the voice-over, which is the combined
  review artefact asked for.
- **Live, by you.** I do not launch Electron; it spams Sei Safe Storage keychain
  prompts. You run a session and I read what it leaves behind: the per-session
  log (`backseat-<characterId>-<ts>.log` plus the in-app LogsBar, both fed by
  `slog`) and the dev grid dumps at
  `<userData>/backseat-debug/grid-<kind>-latest.jpg`. Step 1 wants an eyeball on
  a grid dump to confirm the log spacing reads as motion.

---

## Progress

- [x] 1. Log-spaced frames: offset table, 10 Hz ring, nearest-sample composite, contract rewrite (`c36f378`)
- [x] 2a. Small VLM unwired and parked (`c36f378`)
- [x] 2b. Idle wake: `nextIdleDelayMs`, self-rescheduling timer, reset on speech (`c36f378`)
- [x] 2c. Priority ladder + per-kind tick notes (`c36f378`)
- [x] 3. Cache layout: breakpoint off the image and onto the history tail, anchored history window (`c36f378`) — NOT yet verified, see below
- [x] 4. `signals.ts` extracted, worker calls into it (`4cfe922`)
- [x] 5a. `backseat-sim.ts` + `--dry` on the clip with current thresholds (`4cfe922`)
- [ ] 5b. Candidate events confirmed with you, thresholds retuned
- [x] 6. Voice-over run (`4cfe922`); cache hit rates NOT obtainable offline
- [ ] Mark `.planning/backseat-redesign-260731.md` superseded; commit this file as `.planning/backseat-v2-260801.md`
- [ ] Update CLAUDE.md "Backseat (260728)" to match
- [ ] Mirror to `sei-studio/backseat`

Checkboxes are ticked in the same commit as the code that satisfies them, so
`git log` and this list cannot disagree.


---

## Results (260801)

### What was wrong in the plan above

**Both jolt arms fire.** The plan predicted neither would, on the reasoning
that continuous gunfire holds the gain median high and that averaging over a
32x18 thumbnail erases localised events. Measured on the clip: 78 of 1873
steps clear +18 dB and 37 of 1863 clear 0.34, collapsing to 7 jolts under the
20 s refractory. The averaging argument is still true (a unit test pins that
one block of a 4x3 split going fully white moves the global mean by 1/12,
below any usable threshold) — it just does not matter for whole-screen events,
which is what actually fires the arm.

So neither MAD-relative thresholds nor block-max has been applied. They were
contingent on the measurement and the measurement did not call for them yet.

**Whether the 7 are the RIGHT 7 is still open**, and the footage limits how
well it can be answered: the clip is an edited montage, and several jolts land
on cuts between highlights rather than on gameplay. Real play has no cuts.
Spot checks: 00:51 gain is a genuine engagement (ammo 25 -> 22, kill banner);
02:15 gain is an edit cut (round timer jumps 0:45 -> 0:06 across 1.3 s of
clip); 02:39 colour is mostly a camera turn. That is step 5b.

### The finding that mattered more

**Attaching tools suppresses speech**, by far the largest effect found. Same
prompt, same grids, n=60 per condition:

| tools attached | spoke |
|---|---|
| none | 60/60 (100%) |
| `REMEMBER_TOOL` only | 47/60 (78%) |
| `SAVE_CLIP_TOOL`, reworded | 43/60 (72%) |
| both, what backseat ships | 41/60 (68%) |
| `SAVE_CLIP_TOOL`, original wording | 37/60 (62%) |

Two effects. The structural one (a tool array costs ~20 points whatever it
says) is the honest price of the clip feature. The wording one is that
save_clip's "This is rare. Most good moments are not clip-worthy" generalised
from "do not clip" to "do not speak"; scoping the rarity to the FILE recovers
about 6 points, roughly one standard error, so directional only. A contract
paragraph saying "tools do not gate speech" did nothing (43 vs 41). This is
very probably the real cause of the 260728 mute session, which was attributed
to contract wording at the time.

**Silence calibration was badly off and is now roughly right.** The first idle
note asked whether anything "worth reacting to" happened; Haiku answered no to
a grid showing health 100 -> 45, thirteen rounds fired, a reload and a kill
banner. 0 lines in 14 looks. The note now asks what CHANGED and names where to
look; the contract restores speaking as the default and lets the note carry the
bar. 5 lines in 13 looks, about one per 37 s.

### The review video

`scripts/backseat-render.ts` renders the clip back out at 1920x1080 with the
monitored state drawn beside it: the log-spaced grid that was actually sent to
the model, the gain trace against its rolling baseline and the +18 dB
threshold, the colour delta against 0.34, the STT transcript, and the wake
state (which source last fired, what it decided, how long until the next
scheduled look). Every wake is labelled on the frame with the mechanism that
produced it and the score that cleared the threshold, which is what makes 5b
reviewable by watching rather than by reading a table.

It reads `voiceover.json`, `signals.csv` and `grids/*.jpg` and recomputes
nothing, so it cannot disagree with `voiceover.md`. Frames are generated with
sharp and piped as raw RGBA into ffmpeg, which composites the source video into
the left panel, so no PNG sequence hits disk.

The transcript comes from `scripts/backseat-transcribe.ts`, which runs the same
model the app packages (`onnx-community/whisper-tiny.en`) over the PCM the sim
already extracted. It is offline and was NOT fed to the model during the run,
and the panel says so. Two things about that model did not work and should not
be retried: passing the whole 187 s array with `chunk_length_s` returns empty
text, and `return_timestamps: true` returns an empty `chunks` array. Six-second
windows work, with a repeat-collapse pass because whisper-tiny loops on gunfire
(one window came back as "I'm coming" repeated 110 times).

```
npx tsx scripts/backseat-transcribe.ts
npx tsx scripts/backseat-render.ts            # ~15 min, writes review.mp4
npx tsx scripts/backseat-render.ts --limit 30 --fps 10   # quick look
```

### Still owed

- **5b:** confirm which of the 7 jolts are real, ideally on unedited footage.
- **The cache change is unverified.** The sim cannot check it: its stub prefix
  is ~1.1k tokens and Haiku will not cache below 2048. It has to be read off a
  live session's `cacheRead=` / `cacheWrite=` log lines.
- **Speech rate at 68% is not a designed number**, it is what the tool array
  happens to cost. If live use wants it lower, the dial should be an explicit
  one (the idle distribution, MIN_SPEAK_GAP_MS) rather than a tool description.
