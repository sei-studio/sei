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
- [x] 5b. Thresholds retuned (`260802`): block-max + dual lookback + MAD-relative
      bar + per-arm refractory. Which events are the RIGHT ones is still open.
- [x] 6. Voice-over run (`4cfe922`); cache hit rates NOT obtainable offline
- [x] Mark `.planning/backseat-redesign-260731.md` superseded; commit this file as `.planning/backseat-v2-260801.md` (`95c7267`)
- [x] Update CLAUDE.md "Backseat (260728)" to match (`260803` — the section had
      gone stale two rounds back and described the gate, the argmax ring and the
      overlay; rewritten whole)
- [ ] Mirror to `sei-studio/backseat`
- [x] 260802 round two: silence removed, screen text (OCR) added, colour arm
      made sensitive, previous grid carried as memory, video rebuilt
- [x] 260803 round three: lines stop narrating (0/10 -> 10/10 asking, median 35
      -> 20 words, em dashes stripped), OCR moved to macOS Vision, prompts
      widened past games, overlay window and games tile deleted, sharing moved
      to the call controls

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

## Round two (260802), from reviewing the video

Four changes, all driven by watching the run rather than by reasoning about it.

### Silence is gone

68% was not tasteful restraint. The clearest example in the clip is the 02:50
scheduled look: a smoke going down mid-site, ammo 4 of 8, and the model said
nothing. This contract has now been through three positions on silence (260728
sanctioned it and got a mute companion; 260801 delegated it to the per-tick
note and got 68%), and two attempts is enough to conclude there is no wording
Haiku applies at a person's bar rather than its own much higher one.

So every look produces a line. `BACKSEAT_CONTRACT`'s "WHEN TO SAY NOTHING"
became "YOU ALWAYS SAY SOMETHING", and each `tickNote` branch lost its
`(silence)` escape and gained an instruction for the case that escape used to
cover: when the screen has not changed, talk about the situation rather than
forcing a reaction to a change that did not happen.

Silence still exists, but only as a MECHANICAL decision taken before the model
is called: `MIN_SPEAK_GAP_MS` drops a jolt or scheduled look that lands within
8 s of a line. A rule that never looks at a moment cannot misjudge one.

`isSilenceFiller` STAYS in `backseatService`. Without it a stray "(silence)"
would be spoken aloud in a voice call. It is now logged as
`turn <kind>: NO LINE despite always-speak`, an anomaly worth counting rather
than the expected path.

**Result: 10 looks, 10 lines, 0 silent.** Two side effects worth watching:
replies grew from roughly 20 to 24-55 words against a contract asking for one
or two short lines, and Haiku still writes em dashes despite being told not to.

### Screen text

New: a second local pass, alongside the Whisper ring, reading the words off the
screen. `tesseract.js` in its own worker (`ocrWorker.ts`), because Tesseract is
synchronous WASM taking about a second and running it beside the frame loop
would stall the ring. Model files download on first use and cache in the
browser, exactly like the Whisper model. Shaping is pure and shared with the
sim (`screenText.ts`): confidence floor 60, punctuation and stray single
letters dropped, capped at `TICK_SCREEN_TEXT_MAX_WORDS` = 80 with an explicit
truncation marker so a page of prose does not dwarf the prompt.

Settings were measured, not defaulted. Over four moments of the clip, three
scales x two page-segmentation modes:

```
PSM.AUTO at any scale ....... 0-11 words, usually nothing
SPARSE_TEXT at 1x ........... 20-27 raw words, nothing legible survives
SPARSE_TEXT at 2x ........... 24-40 raw, recovers "A Short", "Site", "550"
SPARSE_TEXT at 3x ........... 41-47 raw, no better, ~2x the time
```

AUTO fails because a game screen is not a page. The 2x upscale matters because
HUD text at 720p is around 12 px tall.

**What it actually produces on Valorant** is a real mix, and the review video
shows it unedited: map callouts ("A Site", "A Short", "A Rafters"), kill-feed
lines ("SPIKE CARRIER KILLED VANDAL", "Pyramid: KILLED"), weapon names, credits
and the round timer, interleaved with garbage ("DB BektW", "ELEE A"). Mean 6
words a frame, 93 of 94 frames produced something. The contract therefore tells
the model this reading is unreliable in a specific way and to use it only to
recognise things it can also see. The value case is not this footage: it is a
player reading a quest log, a browser or subtitles, where the grid is useless
and the words are the whole point.

### Colour: block-max, dual lookback, and a bar that moves

The complaint was that colour fired on the compilation's edit cuts and never
within a scene. Three changes, in order of how much each mattered:

1. **Block max over a 4x3 split** instead of a mean over the whole thumbnail.
   Averaging is what made a localised change invisible: one block going fully
   white moves the global mean by 1/12, below any usable threshold. Both
   numbers are pinned in `signals.test.ts`.
2. **Two lookbacks, 1.0 s and 2.5 s, take the max.** A doorway takes one to
   three seconds and never looks like more than panning inside any single
   second. (The old single lookback also did not do what it said: the trace was
   pruned at 3x the lookback and the lookup took the first entry at least a
   second old, which is always the oldest one held, so the real comparison was
   against ~3 s ago. `thumbAt` resolves a target age properly now.)
3. **The threshold became `median + 4 x MAD` over a 15 s window**, floored at
   0.2, replacing the fixed 0.34. This is the change that actually made the arm
   work, and the measurement is unambiguous: with block-max the clip's colour
   delta has a MEDIAN of 0.313 and a p95 of 0.520. At a fixed 0.34 the arm was
   over threshold on 38% of steps and every "event" it raised was really the
   refractory period expiring, six of them spaced almost exactly 20 s apart. No
   absolute number can be both sensitive in a calm game and quiet in a shooter.

**The refractory is now per arm.** Shared, whichever arm fired first swallowed
the other's next 20 seconds, and a more sensitive colour arm immediately began
eating confirmed kills: a colour jolt at 01:41 suppressed the +18.9 dB spike at
01:55, the clearest real event in the footage.

Before: 3 colour (all on cuts) + 3 gain. After: **5 colour, all mid-scene, plus
all 4 gain events.** Three of the five colour jolts clear the bar only
narrowly (0.484 vs 0.475, 0.491 vs 0.487, 0.513 vs 0.490), which is visible in
the video and is the thing to judge. `JOLT_COLOR_MAD` is the dial: 5 makes
colour rare again (1 event on this clip) and is a one-line revert.

### The companion remembers the last grid

Chat history is text and the service rebuilds messages from the chat store,
which has never held an image, so each look used to be the companion's entire
visual world. With silence removed, repetition becomes the dominant failure
mode and that gap is what makes it unavoidable.

The renderer now emits a half-size copy of every grid; main holds the one from
the turn that last produced a line and sends it back with the next tick.
602x504 is 396 visual tokens against the full grid's 1548, all six cells
present, unmistakably older and smaller. It sits AFTER the cache breakpoint as
plain input: moving it above would change the message array's shape every tick
and invalidate the whole prefix to save 396 tokens. Dropped past
`PREV_GRID_MAX_AGE_MS` (3 min), so a picture from before a pause is never sent.

"When it last spoke" was already in `tickNote` and is now accurate rather than
approximately so, since every look updates it.

### The video, second edition

Same artefact, rebuilt against the new run. The audio transcript moved to the
left column beside the companion, freeing the space under the grid for the
SCREEN TEXT panel, which shows the reading, when it was taken, and whether it
was the one a given look carried. The colour plot's dashed threshold now MOVES,
because the threshold moves. The memory image is drawn as an inset in the grid,
captioned with the look it came from.

One real bug came out of building it: the sim named grid dumps by turn number
and wake kind, so a run with a different wake sequence left orphans behind, and
the renderer indexed a sorted `readdir` by turn position. Every grid it drew was
shifted. The sim now clears the directory and records each turn's filename, and
the renderer refuses to guess when the counts disagree.

```
npx tsx scripts/backseat-ocr.ts               # screen text, ~5 min, cached
npx tsx scripts/backseat-transcribe.ts        # game audio, cached
npx tsx scripts/backseat-sim.ts --dry         # signals only, no model calls
npx tsx scripts/backseat-sim.ts               # the voice-over
npx tsx scripts/backseat-render.ts            # ~15 min, writes review.mp4
```

## Round three (260803), from the second review

Four notes, and the last one is the largest change to this feature since it
shipped.

### The lines were narration

Removing silence fixed how often the companion spoke and revealed what it was
saying: "you just got caught", "you just used a skill", "health is dropping."
Every one of those is true and every one of them describes a screen the player
is looking at. The note back was exact: *"OBVIOUSLY I know that, I don't need
you to tell me what I see."*

So the contract gained two paragraphs and lost the assumption underneath it.
`THE POINT OF A LINE` says the screen is the thing you have in common, not the
subject, and that the line should carry what the player does NOT have: an
opinion, a question, a want, a memory. `SAY SOMETHING THEY CAN ANSWER` says the
line should leave them something to reply to, and that WHICH of those a
companion reaches for is a matter of personality rather than of the moment.

Abstract instruction alone did not move it. What did was four BAD/GOOD contrast
pairs written into the contract, one of them deliberately not a game:

```
BAD:  "You just got caught out in the open with no cover."
GOOD: "Why were you out there with nothing to hide behind?"
BAD:  "She just told him she is leaving and he did not argue."
GOOD: "He was never going to fight for her, was he."
```

Measured over the same ten looks, before and after:

```
                        260802        260803
lines that ask anything    0/10         10/10
median words                ~35            20
em dashes                  8/10          0/10
```

The em dashes are not a prompt result. "Do not use em dashes" had been in the
contract since 260802 and Haiku ignored it, so `stripDashes` now removes them
after the fact, replacing each with a full stop or a comma. That matters more
here than in chat because these lines are SPOKEN, and a dash is not a sound.

10/10 asking a question is itself worth watching. The contract says not every
line needs a question mark, and the model overshot from one extreme to the
other. If it reads as an interrogation in a live session, that paragraph is the
dial.

### OCR got a lot better

The note was "I think OCR can get a lot better than this. Basic OCR." It was
right, and the fix was to stop using Tesseract on macOS.

Vision (`VNRecognizeTextRequest`) was probed against the shipped tesseract.js
path on identical frames:

```
0:14  tesseract  "Orange 50 NG IN"
      vision     "B Orange / 5 / SPIKE PLANTED / 50 100 / 1,550"
0:40  tesseract  "A Site ne i 410 (OPERATOR 100 1"
      vision     "A Site / 1:17 / SIGNATURE ABILITY CHARGED / 410 / 2,150"
1:28  tesseract  "KILLED BY vio COMBAT 46 55 Team Clin In Deteader Side Spawn"
      vision     "Sova / KILLED BY / Sova / OUTGOING / 105 / COMBAT REPORT /
                  INCOMING / 46 / Karasu / In Defender Side Spawn Team /
                  (Eliminated) / 190 / KILLED / 146"

      ~1000 ms/frame at a 2x upscale      ~72 ms/frame at native 720p
```

Over the whole clip: 94 of 94 frames produced text at a mean of 23 words,
against 6. It is ten times faster, an order of magnitude more accurate, and it
does not need the upscale Tesseract could not work without.

It ships the same way the audio tap does, which is the whole reason it was
cheap: a small Swift binary (`native/mac-ocr`), built universal by
`scripts/build-mac-ocr.sh`, spawned by main and spoken to over stdio with a
length-prefixed frame in and a JSON line out. tesseract.js stays as the fallback
for Windows and Linux, where the same job wants `Windows.Media.Ocr` and does not
have it yet.

Two settings were measured rather than defaulted. `usesLanguageCorrection` is
OFF: this is proper nouns, callouts and scoreboard tokens rather than prose, and
correction rewrites exactly the names a companion needs verbatim.
`minimumTextHeight` drops to 0.008, because the 1/32 default discards most of a
HUD. The confidence floor did not need to move: over 94 frames Vision's
confidence is effectively trinary, 959 lines came back at 100 and every one of
the 76 below 60 was garbage, so the existing bar of 60 separates them exactly.

The unit also changed from the WORD to the LINE. Both engines report lines and
the old shaping threw that away, which invented phrases: "A Site" at the top of
the screen and "1,550" at the bottom became "A Site SPIKE PLANTED 1,550", a
sentence nobody wrote. Lines are now joined with ` / ` so the model can see
where one ends.

On the question asked alongside it, whether OCR text is stored with each grid:
it never was. The reading rides the CURRENT tick only, and the previous-grid
memory is an image with no text attached. There was nothing to drop.

### It is not only for games

The contract said "game" throughout, which quietly narrowed the companion to
sports commentary over a film. Every noun is now about what is on SCREEN: a
film, a show, a video, a stream, something being made or read or shopped for.
The idle note no longer names health, ammo and the score as the places to look.
This is why one of the BAD/GOOD pairs above is a scene from a drama.

### The UI is Discord's, and the overlay is gone

The biggest structural change. Backseat was a tile in "Play together" that
opened its own always-on-top window. It is now a share button in the call
controls.

- The **overlay window is deleted** (`src/main/backseatOverlay.ts`,
  `BackseatOverlay.tsx`, the `?backseat=1` branch in `main.tsx`). With it went
  text mode, which had nowhere to live, and the pause button, which the share
  toggle replaces.
- The **"Backseat" tile is deleted**. Sharing your screen is not a game and does
  not belong in a grid beside chess.
- **Capture moved into the main window.** The overlay existed because Chromium
  clamps timers in an occluded renderer and a session runs behind a fullscreen
  game. That reason no longer stands alone: the main window already sets
  `backgroundThrottling: false` for exactly this, and the frame pump is a
  `MediaStreamTrackProcessor` in a worker, immune either way. `useBackseatStore`
  owns the capture handle now, which collapsed a two-window state mirror and a
  push fan-out into one path.
- **The call window shows the share.** The preview fills the stage and the
  avatars demote to a small strip with the compact controls, the same move the
  game surfaces make, so "something else is the main thing now" looks the same
  everywhere in the app.
- Sharing **requires a call and ends with one**: hanging up stops it.

What survived unchanged is the cross-launch gate. A companion still cannot watch
your screen and stand in your Minecraft world at the same time, so
`activeGameFor` still reports a live share even though nothing launches one from
the picker any more.

## Round four (260804), from the first live session

The first real session with round three's build produced a log with **zero
`user` ticks in 168 seconds** and a report that there appeared to be two
companions.

### There were two companions

Not a figure of speech. Backseat runs a turn loop with the grid attached; the
voice director runs one with the microphone attached. Both write to the same
chat thread and both speak through the same call, and neither has ever known
about the other. Round three deleted the overlay, which was the only surface
that raised a `user` tick, so the last thread connecting the player to the
screen-watching companion went with it. What was left was exactly what was
reported: one companion who could see the screen and never heard a word, and
one who could hear and had no idea what was on screen, taking turns.

`dispatchUserTurn` now routes the utterance to `capture.sendUserTick` for a
companion that is sharing, and skips its ordinary voice turn. The share is the
more informed of the two loops (grid, audio transcript and window title on top
of everything the voice turn has), so it is the one that wins. Anyone else on
the call is unaffected. The grid is latched at `onSpeechActive(true)` rather
than at the end of the sentence, because someone reacting to a moment is
describing the moment they reacted to.

Two supporting changes fell out of it. A `user` tick gets `max_tokens` 400
instead of 160, because it is now the only answer the player gets. And a
confirmed barge-in calls `backseatInterrupt`, because clearing the audio queue
only silences what is already synthesised.

### The log also proved the cache layout works, and that a field was being eaten

`cacheRead=9017` from the second tick on, `cacheWrite` near zero. That closes
the item this document has been carrying since 260801 as unverifiable offline.

Reading the same path to check it turned up something else. The zod schema for
`backseat:tick` in `main/ipc.ts` never declared `gridSmall`, and zod strips what
it does not name. The previous-grid memory added on 260802 has therefore been
shipping, documented, and reaching the model **never** — invisible because a
null `prevGrid` is a legal state on the first tick of every session. Declared
now, along with the two new fields.

### The OCR pass is gone, and it was working

Screen text was measured, tuned, and good: whole phrases at ~72 ms, 94 of 94
frames, 23 words a frame against Tesseract's 6. It was removed anyway, on the
grounds that it answered the wrong question. A HUD full of numbers does not tell
you whether you are watching a game or a stream of that game, and the window
title does, in four words, for one enumeration every five seconds instead of a
recognition pass on every other frame. `shareLabel` carries the shared window's
CURRENT title — re-read, not pinned, because a browser tab switch changes the
screen completely under a fixed source id — or on a whole-screen share the
frontmost window's.

Deleted with it: `native/mac-ocr`, `visionOcr.ts`, `ocrWorker.ts`,
`screenText.ts`, `scripts/backseat-ocr.ts`, the three OCR IPC channels, the
tesseract.js dependency and the second signed Mach-O in the mac bundle. That
also retires two items this document was carrying (Windows native OCR, and the
unbundled tesseract fallback) and most of a third (the lockfile).

### Six identical frames

The companion asked why it had been shown "six identical YouTube frames", which
is the clearest possible evidence that it was reading the repetition as
meaningful. It was a fair question: six identical cells claim six sampled
moments and carry the information of one, at 1548 tokens.

Consecutive cells that are the same picture now collapse to one and the canvas
is sized to the survivors. The test is `blockMaxDelta` over the 32x18 thumbnail
already kept for the colour arm, at 0.02, so a change covering one corner of the
screen still counts. Measured on a synthetic frozen-then-moving clip: the frozen
stretch produces a **one-cell grid, 264 visual tokens against 1548**, and the
moving stretch still produces six. On the Valorant clip one look in ten dropped
frames, which is the right answer for footage that never stops moving.

Because the grid is variable-size, `frameAges` rides each tick and `tickNote`
states the ages per look. A fixed 2x3 could be described once in the cached
contract; this cannot.

### Interrupting her

The interrupt was purely energy: sustained loudness over an adaptive bar, and on
trip it CLEARED the queue. One gate serving two contradictory masters, which is
why six rounds of tuning across three reports moved the numbers and never
resolved it. Trip easily and speaker echo destroys a line for nothing; trip
reluctantly and interrupting takes shouting.

Two stages with opposite temperaments resolves it, and the second stage is
dictation, which is what was asked for:

1. **Duck** on one frame over a low bar. ~130 ms, against ~400 ms, and with no
   600 ms grace-window blind spot at the start of every clip. Reversible, which
   is the whole reason the bar can be that low.
2. **Commit** only when the ~400 ms collected since the duck transcribes to a
   real word. A cough, a keyboard, a door, her own echo: all come back empty or
   junk, and the clip resumes.

Perceived interrupt is roughly three times faster. The commit is slower
(~500-800 ms against 400 ms) and that is the right trade, because by then she
has been silent for hundreds of milliseconds and nobody hears a decision.
Sustained energy survives only as a slow fallback for when transcription cannot
answer at all.

`hasSpokenWord` is stricter than the junk filter used on finished utterances,
because it runs on 400 ms of audio where every engine invents. Its
repeated-letter rule is scoped to Latin script: 等等 is a word, and two tests
written before the code was read caught both that and `(music)` slipping
through.

### Also

The picker's Window and Entire screen lists are two tabs. Stacked, the screens
sat below however many windows the player had open, which is always.

### What round three got wrong that this fixes

Restructuring `HOW YOU TALK` to give a spoken-to turn a longer answer moved the
length rule out of the opening sentence and into a conditional. Measured
immediately: median words went 20 to 36.5 and the lines went back to narration.
The rule is unconditional again and the exception lives in `THEY CAN TALK BACK`.
Same ten looks after the fix: **median 17.5 words (12-29), 10/10 asking, 0 em
dashes.** Conditional instructions are weaker than unconditional ones, and the
opening sentence of a paragraph is worth more than the last.

### Still owed

- **5b:** confirm which jolts are real, ideally on unedited footage. The colour
  arm now fires mid-scene, which is what was asked for, but whether those five
  moments are the RIGHT five is a judgement no threshold sweep can make.
- **Every line is now a question (10/10).** Fixed, and possibly overfixed. The
  contract says not all of them need to be; if a live session reads as an
  interrogation, `SAY SOMETHING THEY CAN ANSWER` is the dial.
- **`tesseract.js` is off the manifest but still in the shared
  `node_modules`.** Nothing imports it. `npm install` in the primary checkout is
  owed before this branch merges, to drop it from the lockfile.
- **The frontmost-window read is a heuristic.** `desktopCapturer` is backed by
  `CGWindowListCopyWindowInfo` with `kCGWindowListOptionOnScreenOnly`, which
  returns windows front to back, so the first entry that is not ours is the
  frontmost. That is a documented ordering of the underlying API and not of
  Electron's wrapper. A wrong answer costs one slightly-off line.
- **The two-stage barge-in has not been heard.** Everything above is measured
  on the word gate and reasoned about the timing; how the duck-then-resume
  actually SOUNDS when it is wrong is the thing to listen for. If a false duck
  is audible as a dropout, `DUCK_VOLUME` and `DUCK_RAMP_MS` are the dials.
- **A spoken turn has no retry.** The voice director retries a failed turn and
  shows "Reconnecting"; the backseat path does not, so a failed turn is a
  dropped answer rather than a broken call.
- **The removed overlay is not re-verified live.** Capture running in the main
  window behind a fullscreen game is argued from `backgroundThrottling: false`
  and the worker frame pump, both of which were already true, but it has not
  been watched in a real session. The signals log line every 10 s is what to
  check.
