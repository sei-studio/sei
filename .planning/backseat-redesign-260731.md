# Backseat redesign: sequence, narration, and wake sources

Branch: `v0.5-backseat`
Worktree: `.claude/worktrees/v0.5-backseat`
Date: 260731

---

## Context

Backseat works, but two problems block it from feeling like a person on the couch:

1. **The companion has no sense of sequence.** It cannot tell you "you dodged then
   fired." Two causes, both in the capture path. First, the grid samples at 1 Hz
   (`GRID_FRAMES` = 6 over `GRID_SPAN_MS` = 6 s), and a dodge-then-fire is roughly
   600 ms, so the events are never sampled. Second, and worse, the frames are not
   evenly spaced at all: `captureWorker.ts:262` picks each cell by running argmax
   over audio gain within a one-second bucket, so consecutive cells land anywhere
   from 40 ms to 1.9 s apart, while `backseatPrompts.ts:51` tells the model they are
   "about a second apart." Every temporal inference the model makes sits on a false
   clock.

2. **We do not know when to talk.** The salience gate targets a fixed pass rate
   (`TARGET_POSITIVE_RATE` = 0.25 in `salienceGate.ts:56`) via a rolling quantile.
   Quantile normalization guarantees the companion talks at the same rate whether
   the player is in a firefight or staring at a menu: on a static screen it still
   fires on a quarter of grids, and during sustained action it is capped at a
   quarter. There is no signal anywhere in the system for "is there room to speak."

A third, quieter problem: the gate throws away 75% of what it looks at. Each call
produces one boolean and the grid is discarded, so the companion's model of the
session has holes exactly where it stayed quiet.

**Intended outcome.** Frames sampled so recent motion is actually resolvable and the
prompt states the truth about spacing. The small VLM narrates instead of judging, and
those narrations accumulate into a timeline that both feeds the main model and drives
the wake decision by novelty rather than by a forced rate. Local visual and audio
detectors rebuilt so they measure events rather than global averages. All wake sources
kept modular so any of them can be disabled, replaced, or removed from config.

---

## Approach

Six stages. Stage 0 is a hard gate: the cosine-similarity method must be measured
before any novelty code is written.

### Stage 0: lab harness and the similarity experiment

**New:** `scripts/backseat-lab.mjs`. Offline, no Electron (launching the app spams
"Sei Safe Storage" keychain prompts, so it stays out of the loop). Three functions:

1. **video to grids.** `ffmpeg` (present at `/opt/homebrew/bin/ffmpeg`) extracts
   frames; `sharp` (already a transitive dep via `@huggingface/transformers`)
   composites them at the real 1204x1008 / 602x336 geometry using the same offset
   table `captureWorker` will use.
2. **grids to real narrations.** Calls the real `Qwen/Qwen3-VL-30B-A3B-Instruct` on
   DeepInfra with the real narrator prompt, using `SEI_GATE_DEV_KEY` from `.env`.
   Dumps `{grid, narration, offsets}` to JSON.
3. **narrations to a separation report.** Pairwise similarity under each candidate
   method, grouped by relatedness class, reporting distribution gap and AUC.

Methods to compare:

| Method | Cost | Risk |
|---|---|---|
| Lexical (TF-IDF cosine over content words) | zero deps, instant | "moves through mid" vs "walks down mid corridor" scores low despite meaning the same |
| Local embedding (`all-MiniLM-L6-v2` q8, ~23 MB, transformers.js) | one more model download; main-process transformers.js is new ground here (Whisper runs in a renderer worker) | probably best semantic separation |
| Hosted embedding (DeepInfra bge) | ~free, +100 ms | second network dep per tick, same "no key in prod" debt the gate already carries (CLAUDE.md "Owed") |
| Structured narration + field diff | zero extra anything | needs the narrator to emit `{scene, actors, action, outcome}` reliably |

The structured option deserves weight: walking versus standing-and-shooting on the
same CSGO map has an **identical scene field and a different action field**, which set
difference separates trivially where free-prose embedding may not, because both
narrations will be dominated by map description. Hypothesis, not assumption.

**Two tiers of evidence, and they prove different things.**

- **Tier 1** uses a corpus written in the narrator's target style across three
  relatedness classes. It screens out bad methods and, more usefully, tunes the
  *narration format*, which is a bigger lever on separation than the metric is. It is
  contaminated by author expectation and is **not** sufficient to lock a threshold.
- **Tier 2** is the real test: real gameplay footage, real grids, real narrations.
  **Blocked on a 2-3 minute CSGO clip containing both boring stretches and fights.**

The experiment must also answer whether similarity sits on a stable enough scale
across content to use a fixed cutoff, or whether it needs the MAD-relative treatment
like every other threshold here.

**Checkpoint: show the separation report before writing any novelty code.**

### Stage 1: log-spaced frames

Offsets `[6.0, 3.0, 1.5, 0.75, 0.375, 0.1875]` seconds before composite, oldest
top-left, row-first. Still 6 frames at 1204x1008, so the Haiku token cap and its
assertion in `src/shared/backseatIpc.test.ts` are untouched.

The current ring cannot serve this: `captureWorker.ts` keeps one JPEG per one-second
bucket and has no sub-second resolution. Replace with two-tier retention:

- **fine tier**, every ~90 ms for the last 2.0 s, held as `ImageBitmap` (no encode, no
  decode, ~22 resident). Serves the four newest cells.
- **coarse tier**, every 500 ms out to `BUFFER_MS` (9 s), held as JPEG. Serves 3.0 s
  and 6.0 s.

Encode rate goes 1/s to 2/s. Memory goes from ~15 JPEGs to ~18 MB of bitmaps plus
~600 KB of JPEGs. That is a real departure from the frugality CLAUDE.md documents, so
**measure it**; the fallback if it bites is encoding the fine tier too (~11 encodes/s),
trading CPU for memory.

**Two deliberate reversals of existing decisions:**

- **Loudest-frame-per-second selection is removed.** It is the direct cause of
  problem 1. Log spacing is meaningless if the frame retrieved is not at the offset
  claimed. Replaced by nearest-frame-to-target, with the tick carrying the **actual**
  offsets so the prompt states truth instead of a convenient fiction. This also
  removes the video-only fallback wrinkle (selection stops depending on audio at all).
- **Cell indices burned into the image**, small and low-contrast in a corner. A
  2-wide grid is maximally ambiguous for reading order and column-major is an equally
  plausible read; an in-image index is far stronger than a sentence in the prompt.
  Risk: the model mentions the numbers, violating the "never mention frames or grids"
  rule. Goes behind its own flag and gets A/B'd rather than assumed.

`BACKSEAT_CONTRACT` in `backseatPrompts.ts` is rewritten to describe non-uniform
spacing and to say the gaps get finer toward the present, which is itself a hint that
the recent cells are where the action is.

**Files:** `src/shared/backseatIpc.ts` (offset table, retention constants),
`src/renderer/src/lib/backseat/captureWorker.ts`,
`src/main/backseat/backseatPrompts.ts`.

### Stage 2: wake-source scaffolding

Done before the behaviour changes so stages 3-5 slot into a shape that already exists.

Today `BackseatTickKind = 'user' | 'gate' | 'jolt'` conflates two things: *who woke us*
and *how the arbiter should treat it*. Split them:

- **Arbitration class** stays binary and stays in `backseatService.handleTick`. `user`
  preempts and always runs; everything else is droppable and never queued. That logic
  is correct and is not being touched.
- **Wake source** becomes open metadata `{ source: string, reason?: string, score?: number }`
  carried on the tick for the prompt and the logs.

Local signals move to `src/renderer/src/lib/backseat/signals/`, one file each, written
as pure functions over explicit state so they are unit-testable. This mirrors the
existing `pcm.ts` and `transcriptRing.ts` "pure + tested" convention. The worker posts
a generic `{type:'signal', source, strength, detail}` instead of the hardcoded
`{type:'jolt', reason}`.

Config block `backseat.wake: { novelty, visual, audio, input }` lets any source be
disabled live. This is the modularity requirement, and it also buys stage 3's
migration safety.

**Files:** `src/shared/backseatIpc.ts`,
`src/renderer/src/lib/backseat/captureController.ts`, `captureWorker.ts`,
`src/main/backseat/backseatService.ts`.

### Stage 3: narrator replaces the gate, novelty replaces the quantile

`src/main/backseat/salienceGate.ts` becomes `src/main/backseat/narrator.ts`. Same
model, same endpoint, same 6 s cadence; the prompt asks for a narration instead of a
yes/no token and `max_tokens` goes 1 to ~60. Logprob parsing and the quantile window
go away, along with `salienceGate.test.ts` (it pins the quantile, which is the thing
being removed).

The narrator prompt receives the **previous narration** and asks what changed since.
That is an easier question than "is this interesting" because it is comparative rather
than calibrated, and it suppresses repetition at the source rather than downstream.

**New:** `src/main/backseat/narrationLog.ts`, a per-session ring of
`{at, text, gridCapturedAt, spoken, similarity}`, feeding three consumers:

1. the novelty check, comparing against recent entries weighted toward the ones the
   companion actually spoke about. This turns "do not repeat yourself"
   (`backseatPrompts.ts:75`) from a prompt instruction into arithmetic.
2. the main model, as a compact timeline. This is what makes cross-tick sequences
   recoverable, and what turns previously discarded ticks into memory.
3. the session log, so the narration stream is inspectable.

**New:** `src/main/backseat/novelty.ts`, pure and tested, implementing whatever stage 0
selects.

**Assumption flagged, not silently guessed.** The instruction was that narrations live
"as long as their corresponding image grids are stored." Literally that is `BUFFER_MS`
= 9 s, which at a 6 s cadence is one or two entries, far too few for novelty
comparison. Read as a **pairing invariant rather than a retention horizon**: keep a
longer text-only ring of ~40 narrations (about four minutes). Text is ~100 bytes per
entry so this is free. Revisit if the literal reading was intended.

**Migration safety.** `salienceGate.ts` stays in the tree for one iteration behind
`backseat.wake.mode: 'salience' | 'novelty'`. If narration plus novelty is worse in
live use, that is a config flip rather than a revert. Stage 2 makes this nearly free.

Latency goes ~520 ms to ~1.1 s per call, still inside the 6 s cadence given the
existing single-flight guard in `captureController.ts`. Cost stays negligible: 60
output tokens is noise next to 1240 image tokens.

**Reuse, do not rebuild:** `buildSystemBlocks` / `markLastMessageCached` /
`REMEMBER_TOOL` from `src/main/chat/chatPrompts.ts`; `toMessages` / `isSilenceFiller` /
`splitReply` from `src/main/chat/chatService.ts`; `createBackseatLog` and the `slog`
two-sink pattern from `src/main/backseat/backseatLog.ts`; `tickTranscript()` from
`src/renderer/src/lib/backseat/sttStream.ts`.

### Stage 4: visual signals

`thumbDelta` (`captureWorker.ts:166`) is a mean absolute per-channel difference over
the whole 32x18 thumbnail. Averaging over the frame mathematically erases localized
events, so a kill feed, a hit marker, or a health bar appearing is invisible at **any**
threshold. Four changes, descending in value per line:

1. **Block-max over a 4x3 split** instead of a global mean. Biggest single win, and it
   yields *where* it changed, which is worth handing to the narrator.
2. **ZNCC-style normalization** before diffing, so exposure and gamma shifts (walking
   into a bright room) stop firing while structural change still does.
3. **MAD-relative threshold** over a rolling window of deltas, replacing the absolute
   `JOLT_COLOR_DELTA = 0.34`. Direct answer to "absolute color change is hard."
4. **Flash detection as its own signal.** Damage vignettes and hit markers are a luma
   spike that *returns* within ~300 ms, a different temporal signature from a cut. The
   current 1 s lookback at 100 ms sampling either misses them or misreads them as
   scene changes.

Histogram distance (16-bin hue, Bhattacharyya) runs **alongside** the structural diff,
not instead of it: structural catches cuts, histogram catches palette shifts like a new
biome or a desaturated death screen. Different events, both cheap.

**Files:** `src/renderer/src/lib/backseat/signals/visualChange.ts` (new, pure +
tested), `captureWorker.ts`, `src/shared/backseatIpc.ts`.

### Stage 5: audio signals

`JOLT_GAIN_DB = 18` over a trailing median is dead in half of games and hair-trigger in
the other half: continuous music gives a high, low-variance floor that nothing clears
by 18 dB, while a quiet exploration game has an `-inf` floor a footstep clears.

1. **Spectral flux** replaces broadband RMS as the onset function. Standard MIR
   approach, ~15 lines over an FFT, fires on transients while ignoring steady music
   level. The 16 kHz mono PCM is already in hand at `captureController.ts:367`, so it
   drops in beside `rmsDb` from `pcm.ts`. Low-frequency weighting helps further, since
   impacts are bass-heavy and dialogue is not.
2. **MAD-relative threshold**, same treatment as the visual arm.

Absolute loudness stays but is repurposed: it is a bad event signal and a good
**talk-window** signal. Loud means do not talk over it. That feeds turn-taking, not
waking.

**Files:** `src/renderer/src/lib/backseat/signals/audioOnset.ts` (new, pure + tested),
`captureController.ts`, `src/shared/backseatIpc.ts`.

### Explicitly not doing yet: input tracking

Keyboard and mouse is the only item carrying a permission and trust cost (macOS Input
Monitoring, on top of the Screen Recording grant the picker already forces). By the
time stages 3-5 land we will know how much of "when to talk" the narration novelty and
talk-window signals already solved. Deciding then costs nothing and may save a scary
permission dialog.

If it does get built later, the scope is **two scalars, not semantics**: input rate as
an arousal proxy, and stillness as a talk-window detector. Capture event timestamps and
a coarse class only, never keycodes, and say so in the UI. It would live in the
existing Swift helper (`native/mac-audio-tap`) as a listen-only `CGEventTap` rather
than a new process or native npm dep.

---

## Verification

- **Unit (`npm test`, vitest).** Every pure module gets tests: the offset-to-frame
  resolver, block-max and ZNCC, spectral flux, the novelty scorer. `backseatIpc.test.ts`
  must still pass unchanged (it pins the 1548-token Haiku budget).
  `salienceGate.test.ts` is deleted with its subject.
- **Offline (`node scripts/backseat-lab.mjs <clip>`).** The separation report for stage
  0. Re-runnable against new footage to tune stage 4 and 5 thresholds without launching
  the app.
- **Live (the human's, not the agent's).** Electron is never launched by the agent (it
  spams "Sei Safe Storage" keychain prompts). A human runs a backseat session; the
  agent reads the evidence it leaves behind: the per-session log
  (`backseat-<characterId>-<ts>.log` plus the in-app LogsBar, both fed by `slog`) and
  the dev grid dumps at `<userData>/backseat-debug/grid-<kind>-latest.jpg`. Stage 1
  wants an eyeball on the grid dumps to confirm the log spacing reads as motion. Stage
  3 wants a session's narration stream read end to end before we retire the salience
  path.
- **Mirror.** CLAUDE.md requires the public standalone repo `sei-studio/backseat` be
  updated when the design moves. Do that once at the end, not per stage.

---

## Progress

Tick these in the same commit as the code that satisfies them, so `git log` and this
list can never disagree.

- [ ] Stage 0a: lab harness written
- [ ] Stage 0b: Tier 1 separation report (method screen + narration format)
- [ ] Stage 0c: Tier 2 separation report on real CSGO footage **(blocked: need clip)**
- [ ] Stage 1: log-spaced frames
- [ ] Stage 2: wake-source scaffolding
- [ ] Stage 3: narrator + narrationLog + novelty
- [ ] Stage 4: visual signals
- [ ] Stage 5: audio signals
- [ ] Retire `salienceGate.ts` after a live session on the novelty path
- [ ] Mirror to `sei-studio/backseat`
- [ ] Update CLAUDE.md "Backseat (260728)" section to match the new design

---

## Working on this across sessions

**This file is the canonical record.** It is committed on `v0.5-backseat` so it travels
with the code, survives any session, worktree, or machine, and follows the CLAUDE.md
rule to commit planning docs alongside what they describe. The dated standalone doc is
the live convention in `.planning/` (see `spam-narration-fix-260616.md`,
`relationship-development-findings-260616.md`); `STATE.md` is stale at v0.4 and is not
the thing to update.

**To resume:** "continue the backseat redesign" is enough if the memory pointer at
`~/.claude/projects/-Users-ouen-slop-sei-studio-sei/memory/backseat-redesign.md` is
still in place; otherwise name this file. Either way, read this doc plus
`git log v0.5-backseat`. Commits are ground truth, the Progress list is the summary.

**Anything durable that outlives this plan belongs in CLAUDE.md, not here.** This doc
is scaffolding and gets archived when the work lands. Measured facts, reversed
decisions, and outstanding debts go in the "Backseat (260728)" section under its
existing **Owed** pattern, which is what the next session actually reads.
