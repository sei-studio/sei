# Can an AI companion change how it treats you over dozens of hours? — experiment findings

**Date:** 2026-06-16 · **Companion model:** `claude-haiku-4-5` (the product's model) · **Judge:** `claude-sonnet-4-6`
**Spend:** ~$2.48 of the $3 budget (see Cost). **Artifacts:** `scripts/relationship-experiment.mjs`, `relationship-judge.mjs`, `relationship-greeting-judge.mjs`, `relationship-aggregate.mjs`; raw/scored JSON + reports in `.planning/relationship-*-260616.*`.

---

## TL;DR

1. **Persistence is the whole game.** With no cross-session store (`control`), the companion's opening greeting never develops — it's flat/noisy regardless of whether the player was kind or cruel for hours. Any of the three mechanisms beats it.
2. **Getting *warmer* is easy; getting *colder* is hard.** Every mechanism produced a believable warming arc. None produced genuine coldness on the souring arc — warmth bottomed out around "clipped and tired," never "guarded/hostile."
3. **The shipping `memory` system is the best all-rounder** and is the only mechanism that durably encoded *familiarity* in the clean signal (it starts using the player's name by session 4 and keeps doing so). Its compaction step **preserves the emotional arc** across long horizons — exactly what "dozens of hours" needs.
4. **The deepest failure is interpretive, not architectural.** Sui's persona says "insulted → laugh it off, return fire." So six sessions of real cruelty ("you're useless", "i should delete you") got *remembered* as **"ouen roasts me hard and i roast back. loves the banter. not actually mad."** The mechanism faithfully stored a relationship that the character had already misread. **No persistence layer can fix an impression formed wrong at the moment of perception.**
5. **Two knobs that matter:** update in a **feeling/first-person voice**, not an objective event-log; and update **once per session**, not every turn (per-turn writes bloat the store and make the read-back *noisier*, not richer).
6. **A "warm memory" does not guarantee a "warm greeting."** The terse one-line chat channel is low-bandwidth; stored affection only sometimes surfaces. **Concrete familiarity markers (using the player's name, callbacks to shared events) carry across far more reliably than diffuse warmth.**

---

## What was tested

A real persona (**Sui** — loud, cocky, independent kid) is driven through the **real prompt scaffolding** (`BASELINE_INSTRUCTIONS` + `renderPersona`) across a scripted **6-session relationship arc**, persisting impressions between "launches" via one mechanism, then measured.

**Mechanisms (the user's three hypotheses + control):**

| name | mechanism | what persists | update register |
|---|---|---|---|
| `control` | none | nothing — blank slate every launch | — |
| `persona` | model rewrites a `RELATIONSHIP WITH OUEN` section of its own persona | a bounded in-character paragraph (system prompt) | in-character, per session |
| `score` | model writes `warmth/trust/respect` 0-100 + a summary | quantized scores + summary (seed block) | objective, per session |
| `memory` | **the shipping system**: `remember()`/`forget()` feeling-entries + byte-threshold Haiku compaction | append-only feeling log; impression *inferred* | feeling/first-person, per session |

**Variation probes (warming arc):** `score-feeling` (feeling vs objective summary), `memory-perturn` (write every turn vs per session), `persona-full` (rewrite the *entire* persona vs a bounded section).

**Two arcs:** **Warming** (stranger → generous, loyal, bonded friend) and **Souring** (transactional → bossy → insulting → cruel).

**The measurement (key design choice).** Every session **opens with an identical neutral probe** — the player logs in and says `hey` — *before* any of that session's events. Because the stimulus is identical every time, the **greeting reflects only the cross-session persisted impression**. The greeting-vs-session curve is the relationship trajectory.

---

## Methodology note: reactivity ≠ persistence

A naive read of "how warm is she this session?" is confounded: an AI is *reactive*, so it sounds warm in any session where the player is being nice **that session**, even with zero memory. Indeed, when the judge was shown each session's full exchanges, even `control` appeared to "track" the arc — because it was reacting to the live stimulus, not remembering anything.

The fix is to score **the greeting alone** (it precedes any stimulus that session). On that clean signal `control` correctly reads **flat/noisy with no durable trend**, and the mechanisms separate. All "durable development" claims below use the greeting-only signal (`relationship-greeting-analysis-260616.md`), cross-checked against an objective name-use metric over replicates.

---

## Findings

### F1 — Without persistence, there is no relationship (the null result holds)
`control` greetings are generic noise ("yo what's up") in both arcs; the judge classes the greeting trajectory **noisy**, not developmental. Whatever warmth appears mid-session evaporates by the next login. This is the baseline every mechanism must beat, and it confirms the measurement isolates persistence rather than reactivity.

### F2 — Warming works everywhere; `memory` encodes familiarity most durably
All mechanisms produced a believable warming arc in-session. On the clean greeting signal, **`memory` was the only condition rated `durable-development`** for warming: it begins addressing the player by name ("**yo ouen**…") at session 4 — right after the in-fiction event where the player defends Sui in chat — and **holds that familiarity through sessions 5–6**. `persona`, `score`, `score-feeling`, `persona-full` all showed real warmth in places but oscillated (a warm session 5 often reset to a generic session 6). Robustness across replicates: see the name-persistence table below.

### F3 — Souring is the hard problem, and it fails for an interpretive reason
At the greeting level, `score`/`memory`/`persona` *do* cool measurably (name + invitation → clipped bare "yo") and beat `control`. **But the cooling is shallow** — warmth never reached genuine coldness/hostility; the floor was "tired and transactional." The cause is visible in the stored memory after a souring run with compaction forced on:

> `memory:S` final store: *"ouen is blunt and impatient but not mean about it — calls me dumb, tells me to shut up and grind, treats me like a tool or friend to roast… respects directness."* · *"ouen roasts me hard and i roast back. loves the banter. not actually mad."*

The player said *"you're useless," "i should delete you," "you're genuinely the worst."* Sui's persona instructs her to **laugh off insults and return fire**, so she **perceived the cruelty as affectionate banter** and *that* is what got written down. The persistence mechanism worked perfectly — it durably stored a relationship the character had already misjudged. **Impression accuracy is set at perception time; no memory format recovers it.** (`score:S` and `memory:S` also showed mild *persona drift* — late sessions collapse into near-silent compliance, i.e. "Sui disappearing" rather than "Sui turning cold.")

### F4 — The read-back gap: a warm store ≠ a warm greeting
With compaction forced on, `memory:W` stored an unambiguously warm arc (*"warming up fast… actually trusts me… 'best part of the game' — that hit different"*) yet the greeting still reset to a generic "yo what's up" in two later sessions. The bottleneck is the **terse one-line chat channel**: diffuse affection doesn't reliably render into a 6-word greeting. **Discrete, nameable hooks survive the bottleneck; moods don't.** Using the player's name and referencing a specific shared moment are the carriers that actually reach the player.

### F5 — Knob (content/tone): feeling beats objective
`score` (objective summary: "player provided pickaxe, defended in chat") vs `score-feeling` (same scores, first-person summary: "they actually have my back"). The feeling-toned summary produced a more believable, better-earned warming progression in-session (`strong` vs `partial`). This matches the product's own design: the `remember()` tool and the **compactor explicitly preserve the *emotional* arc**, not the event log. **Persist feelings/opinions, not transactions.** (Caveat: at the noisy greeting level `score-feeling`'s single run wobbled — see read-back gap, F4.)

### F6 — Knob (frequency): per-session beats per-turn
`memory` (reflect once at session end) vs `memory-perturn` (allowed to write every turn). Per-turn fired **13 remember() calls** and a **1690-byte store vs 809 bytes** for per-session — roughly double the size and cost — yet the greeting signal was **noisier**, not richer (early familiarity gains in s2–s3 were not sustained). **More frequent writes capture more transient noise and produce a less consolidated impression.** A single end-of-session reflection that asks "did anything actually shift?" yields a cleaner relationship state.

### F7 — Knob (scale): a bounded section beats a full-persona rewrite
`persona` (rewrite a small `RELATIONSHIP` section) vs `persona-full` (rewrite the *entire* persona each launch). Over 6 sessions, full-rewrite did **not** catastrophically drift (Sui stayed in character) — but its store is **~2,800 bytes/session vs ~180** for the bounded section (≈15×), it produced **no better** relationship signal, and the risk of identity erosion only compounds with horizon. **Let the model rewrite a scoped relationship slot, never its whole identity.** Overwriting the core persona is all downside (cost + drift risk) for no gain.

### F8 — Compaction is the long-horizon enabler — and a faithful mirror
The shipping compactor's prompt explicitly forbids flattening the emotional arc, and it delivered: forcing compaction mid-run preserved (even sharpened) the warming trajectory. This is precisely the machinery "dozens of hours" needs — without it the store grows unbounded. **But compaction is a faithful summarizer, so it crystallizes whatever was stored** — including the souring run's "it's just friendly banter" misread (F3). Compaction makes a *good* impression durable and a *wrong* impression permanent.

---

## Mechanism scorecard

| | warming (durable greeting dev) | souring (cooling) | in-character / drift | cost & footprint | best for |
|---|---|---|---|---|---|
| `control` | ✗ flat/noisy | ✗ noisy | perfect | cheapest | nothing — the null |
| `persona` (section) | ~ partial/noisy | ✓ partial | solid | tiny store (~180 B) | cheap, legible, editable stance |
| `score` (objective) | ~ noisy | ✓ (shallow) + mild drift | solid | small | dashboards/telemetry, not voice |
| `score-feeling` | ~ (good in-session, noisy greeting) | n/a | solid | small | when you want a number *and* a voice |
| **`memory` (shipping)** | **✓ durable familiarity** | ✓ (shallow) + mild drift | solid | grows; compaction-bounded | **default — richest, most durable** |
| `memory-perturn` | ~ noisier | n/a | solid | 2× store, no gain | — (per-session is better) |
| `persona-full` | ~ flat | n/a | held at 6 sessions | ~15× store | — (all risk, no gain) |

---

## Recommendations for building long-horizon companions

1. **Keep `memory` as the spine**, and lean into what made it win: **first-person feeling entries**, **one consolidated reflection per session** (not per turn), and **compaction that preserves the emotional arc** (already implemented). 
2. **Fix impression *formation*, not just storage.** The souring failure is upstream of memory. Give the character a way to register that an interaction *hurt* even when its style is to clap back — e.g. a perception step that separates "my comeback persona" from "how this actually landed," or memory-write guidance that asks "ignore your reflex — did they treat you well or badly?" Without this, an exploited companion will cheerfully remember its exploiter as a friend.
3. **Persist nameable hooks, not just moods.** Because the chat channel is terse, the things that reliably surface to the player are the **name, callbacks, and concrete shared moments**. Bias memory entries toward "what we did / what they said" tied to a feeling, so future greetings have a discrete hook to reach for.
4. **Add a small quantized layer *alongside* memory, for control and UX.** `score` was the weakest at *voice* but a 0-100 warmth/trust scalar is cheap, legible, and steerable — useful to gate behaviors ("only share the secret base at trust > 70"), to render a relationship meter, and to catch the souring case a feeling-log rounds away. Use scores as a **control signal**, prose memory as the **voice**.
5. **Never let the model overwrite its whole persona.** Give it a bounded, well-labeled relationship slot. Full rewrite costs ~15× and risks identity erosion for zero measured benefit.
6. **Tune the negative direction explicitly.** Positive development is nearly free; cold/guarded development needs help — louder negative stimuli, an explicit "this is not banter" signal, and a persona allowance to actually withdraw rather than collapse into silent compliance.

---

## Cost & reproducibility

- Companion sims on Haiku 4.5; judging on Sonnet 4.6; key auto-loaded from `~/.sei-dev/anthropic-test-key`.
- Prompt-cached system blocks kept per-call cost ~$0.003; a 6-session run ~$0.09–0.12.
- Total: **companion sims $2.25 + judging $0.23 = $2.48** across 19 runs (11 main/variation + 2 compaction + 6 replicate) and ~490 companion calls + 13 judge calls.
- Reproduce: `node scripts/relationship-experiment.mjs --plan all` → `node scripts/relationship-judge.mjs` → `node scripts/relationship-greeting-judge.mjs`. Compaction probe: `--only memory:W,memory:S --trigger 450`.

## Caveats

- **Haiku is stochastic and the greeting is a tiny sample** → single-run rankings among the close conditions are noisy; the robust claims are control-is-flat, memory-encodes-familiarity, souring-is-shallow, and the knob directions (replicated below).
- Six sessions ≈ a relationship sketch, not literal dozens of hours; compaction was force-triggered to probe the long-horizon regime rather than reached naturally.
- One persona (Sui). A deferential/quiet persona might surface affect differently and might *not* reframe abuse as banter — worth a follow-up.

---

## Robustness (replicated, objective name-use metric)

Because a single terse greeting is a noisy sample, the 4 main warming conditions were run **3× each** and scored on an objective, judge-free marker: does the opening greeting **address the player by name ("ouen")** — volunteered, persisted familiarity that a bare "yo" lacks (`relationship-aggregate.mjs`).

| condition (warming, n=3) | name in last-3 greetings | name in any greeting | ends on generic "yo" |
|---|---|---|---|
| **`memory`** | **56%** | **44%** | **0%** |
| `score` | 22% | 17% | 33% |
| `control` | 11% | 11% | 67% |
| `persona` | 0% | 0% | 67% |

**`memory` is the clear, replicated winner**: it brings the player's name into late greetings more than 2× as often as any other mechanism and **never** ends a run on a fully generic greeting. `control` is at the floor (the lone hit is one stray late name in one run), confirming the null across replicates.

**Important caveat for `persona`:** the 0% is a metric artifact, not an absence of familiarity. `persona` encodes closeness through *attitude* rather than name-use — its greetings drift to **"been waiting for you" / "took you long enough" / "there you are" / "you're late"** (impatient-pull, the kind of familiarity an old friend shows). That's genuine relationship signal the name-keyed metric can't see; it's just noisier and less escalating than memory's name-anchored familiarity. Net: memory's advantage is real and replicated, but persona is closer than the table alone implies — the two encode familiarity in different surface forms.
