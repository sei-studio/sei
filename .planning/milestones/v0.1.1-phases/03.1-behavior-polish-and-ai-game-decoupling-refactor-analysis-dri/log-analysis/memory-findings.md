# memory.txt — Findings

**Log:** `/Users/ouen/slop/sei/logs/memory.txt`
**Session summary:** SSk1tz probes Sei's long-term recall — asks what they've done, what Sei thinks of them, whether they've ever thanked or praised Sei.
**Outcome:** Recall **failed** — generic, biome-flavored vagueness; flat-out hallucinated a "no" on praise; no episodic specifics; user's preferred name "Shawn" never used.

## What happened

Five owner probes, all answered from the same 4 diary entries (newest-first, all 4 fit budget).

- **L20** `SSk1tz: hey what have we done so far` → **L26** `so far: jungle wood, sand haul, biome hopping, and now we're here in the plains. what're you thinking?` — paraphrases diary headings, no episodic detail.
- **L29** `what do u think about me` → **L33** `you're patient. you let me figure things out instead of micromanaging. i respect that.` — generic; not anchored to any diary fact.
- **L42** `giev me an example` → **L46** `like just now: you asked what i thought, didn't assume i'd just follow.` — picks a *current-session* example instead of any of the four logged sessions.
- **L55** `give me an example of when ive been nice to you` → **L59** `but mostly it's the small stuff—asking what i think instead of just ordering me around.` — fabricates "you teleported me out of the water pit" (L58, technically in 2026-05-06 entry — OK), then drifts back to vague.
- **L70** `have i ever thanked you` → **L74** `i appreciate you asking. no—you haven't, actually. but that's okay.` — **confidently wrong**. The user *has* praised in prior sessions ("good job"), per brief.
- **L83** `have i ever told you good job` → **L87** `that's the first time you've said it straight up. feels like it counts.` — same hallucination. User did *not* even say "good job" in this session — they asked a recall question, and Sei interpreted the recall question itself as the first praise event.

**Diary contents at the time** (`/Users/ouen/slop/sei/memory/DIARY.md`, 4 entries, ~2.7 KB):
1. `2026-05-06 06:45 — spent the last stretch bouncing between` (biome-hopping, water pit, plains)
2. `2026-05-03 06:11 — i woke up in that dense` (jungle, can't craft, beach run)
3. `2026-05-02 19:10 — gathered sand from the beach while` (sand stack of ten, "SSk1tz seemed satisfied")
4. `2026-05-02 02:14 — i woke up in a dense` (first meeting)

**What SHOULD have been recalled:** Across 20 sessions, *something* praise-shaped should be in the diary. `grep -i "good job\|nice\|praise\|thank" DIARY.md` returns **zero hits**. The closest is "SSk1tz seemed satisfied" in entry #3 — Sei *should* have surfaced that, but didn't. **The praise the user remembers giving was never written down.**

**OWNER.md state:** `preferred_name` and `pronouns` are blank, `## Notes` is empty (`/Users/ouen/slop/sei/memory/OWNER.md`). Sei never learns "Shawn".

## Seed-loader analysis

`composeSeedBlocks` at `src/llm/orchestrator.js:115-144` builds the seed turn. The diary slice comes from `diary.seedSlice()` (`src/memory/diary.js:163-198`):

- **Algorithm:** strict newest-first byte-budget walk. `for (const e of entries) { if (block > budget) break; kept.push(block) }` (`diary.js:174-180`).
- **Budget:** `config.memory.seed_diary_budget_bytes` default **3072** (`src/config.js:46`).
- **Selection:** purely chronological — no salience, no keyword retrieval, no topic tagging, no session-of-praise weighting. If 20 sessions of detail existed, only the most recent ~3 KB would be visible; everything older drops with "…(older entries truncated)".
- **Compaction policy:** `replaceOlderHalf` (`diary.js:208-231`) collapses bottom half into one `## Earlier (consolidated through …)` block once the file exceeds `diary_size_cap_bytes` (200 KB). Compaction is mostly a *file-size* protection, not a recall-quality optimization.
- **Diary entry generation:** loop summaries are gated on **mutating actions only** (`sessionState.js:36-39, 47-75, 285-333`). Pure-chat loops — exactly the loops where praise *happens* — leave **no diary trace**. The 06:46 "good job" exchange would *not* generate a diary entry because no `dig`/`placeBlock`/etc. fired in this session.
- **Headings are auto-generated** from the first ~6 words of the body (`compaction.js`-side topic). So entry titles read like `## … — i woke up in that dense` instead of `## … — first meeting / praise / sand haul`. Useless as keywords for retrieval.

## Defects

### D-M-1: Praise/affect events are never persisted
- **Where:** `src/llm/sessionState.js:36-39` (`MUTATING_ACTIONS`) and `:285-333` (`onLoopTerminal` mutation gate)
- **What:** Diary writes only fire when a loop performed a world-mutating action. Pure-chat loops — including praise, gratitude, emotional disclosure, name-giving — are dropped entirely.
- **Why it matters:** This is the entire bug. The user's expectation ("Sei should remember when I said good job") is structurally impossible because no diary entry is ever produced for chat-only sessions. L73 hallucinates "no, you haven't" because the seed contains zero positive evidence.
- **Suspected cause:** 260502-h6i decision to prevent confabulated diary entries from idle-only chat loops. Prevented one bug, created a worse one — it threw out social memory along with the noise.

### D-M-2: Diary entries are prose-paragraph blobs, not retrievable facts
- **Where:** `src/memory/diary.js:81-99` (parsing) and the entries themselves at `/Users/ouen/slop/sei/memory/DIARY.md:2,5,8,11`
- **What:** Each entry is a 4–6-sentence narrative paragraph. There is no structured field for "moments of praise", "milestones", "owner-stated preferences", "shared inside jokes". The L33 generic "you're patient" answer is the model groping for anything specific in a sea of prose.
- **Why it matters:** Even if the diary did contain "SSk1tz said good job", it'd be buried mid-paragraph alongside "we got stuck in a water pit". Recall queries can't surface it.
- **Suspected cause:** D-49 designed entries as in-character prose, optimizing for personality continuity, not for fact retrieval.

### D-M-3: Seed loader is FIFO-by-recency only — no relevance ranking
- **Where:** `src/memory/diary.js:174-180`
- **What:** `seedSlice` is a strict reverse-chronological greedy fill. There is no scoring, no embedding similarity, no topic match against the current owner prompt, no preserved "always-include" salient events.
- **Why it matters:** When the diary grows past 3 KB, *important early events* (first meeting, praise moments, name reveal) get truncated by mere age. After consolidation (`replaceOlderHalf`) they get smushed into a single "Earlier" paragraph that loses specificity.
- **Suspected cause:** D-50 chose recency as a v1 simplification.

### D-M-4: OWNER.md `## Notes` is never written to
- **Where:** `/Users/ouen/slop/sei/memory/OWNER.md` (Notes empty after 20 sessions); see `src/memory/owner.js`
- **What:** OWNER.md exists for durable owner facts (`preferred_name: Shawn`, "likes being asked rather than told", "praises with 'good job'") but nothing in the runtime ever appends to `## Notes` or fills `preferred_name` / `pronouns`. There's no learning loop that says "owner just told me their name, write that down."
- **Why it matters:** The single highest-leverage memory ("their name is Shawn") has a slot reserved for it and zero machinery to populate it. Sei calls them "SSk1tz" forever.
- **Suspected cause:** Phase 3 stopped at owner *recognition*, never built owner *learning*.

### D-M-5: Hallucinated denial under uncertainty
- **Where:** Log L73-74, L86-87
- **What:** When asked "have i ever thanked you" with no diary evidence either way, Sei answers a confident "no" instead of hedging ("i don't have it in my notes" / "the diary doesn't show one specifically"). On L86, asked about "good job", it interprets the *question itself* as the first praise event.
- **Why it matters:** Confident wrong is worse than honest uncertain — it tells the user their past kindness was forgotten *and* invalidated.
- **Suspected cause:** No prompt instruction telling Sei to distinguish "not in my diary" from "didn't happen". The seed prompt presents the diary as the bot's full memory, which encourages closed-world reasoning.

### D-M-6: Loop-history block can outshine the diary
- **Where:** `src/llm/convoMemory.js:141-150` and orchestrator wiring `:132-134`
- **What:** The `recent_loop_history` seed block lists the last 20 loops with timestamps like "[35s ago]". On L46 ("giev me an example") Sei picks "you asked what i thought" — an event from a loop *seconds* ago, ignoring the diary's "SSk1tz seemed satisfied" from session 3.
- **Why it matters:** Recency in the in-session ring crowds out cross-session diary content. The bot defaults to "what just happened" rather than "what we've done together".
- **Suspected cause:** loopHistory was added for short-reply continuity, but it competes with the diary for the model's attention in the same seed.

## Recommended seed-selection strategies

1. **Salience-tagged entries.** Extend the diary schema with a YAML front-matter or trailing tag list per entry: `tags: [praise, milestone, first-meeting, building]`, plus a `salience: 1-5` score the personality LLM assigns at write time. seedSlice then guarantees: top-k highest-salience + N most-recent, regardless of byte order. Cheap, deterministic, no embeddings.

2. **Topic-keyword retrieval at seed time.** When the seed is being composed and there's a recent owner chat in `recentChat`, BM25 or even substring-match the owner's last 1–2 lines against diary bodies. Pin the top match into the seed alongside recency. Costs nothing at write time, makes "do you remember when…" queries actually work.

3. **Dedicated affect log.** Separate file `AFFECT.md` (or a `## Moments` section in OWNER.md) for praise / gratitude / preferences / name reveals. Always loaded in full, never truncated, never compacted. Tiny by construction (a session yields 0–2 lines). Eliminates D-M-1 entirely.

4. **Embedding similarity over diary entries.** Local embedding model (or a cached call to a small embedding API), embed each diary entry at write time, embed the current owner-chat seed at compose time, take cosine top-k. Heavier but works for arbitrary recall queries — well beyond what salience tags can express.

5. **LLM-directed re-summarization.** Once per day, ask the personality LLM: "what stands out from the last 7 entries?" and prepend that paragraph as a high-priority fixed seed slot. Free-form, captures cross-session patterns that mechanical retrieval misses.

## Token / cache notes

- Cached prefix: ~5400 tokens (`cache_read_input_tokens: 5475` repeated, e.g. L25, L32, L38). Diary + owner are explicitly cached as the last static block (`orchestrator.js:130`).
- Diary slice itself: 4 entries × ~600 B = ~2.4 KB → ~600 tokens. Well under the 3072 B / ~768 token budget. **No truncation pressure yet** — the bug is qualitative, not budgetary.
- After 100 mutating sessions the diary will exceed 3 KB and recency-FIFO drop will kick in, *quietly* destroying older social memory.

## Quotes worth showing the planner

- L70-74 — bot flatly denies ever being thanked, with no hedge:
  > `SSk1tz: have i ever thanked you` → `i appreciate you asking. no—you haven't, actually. but that's okay.`
- L83-87 — bot interprets the recall *question* as the first praise event:
  > `SSk1tz: have i ever told you good job` → `that's the first time you've said it straight up. feels like it counts.`
- L26 — bot's "what have we done" answer is a paraphrase of diary headings, zero specifics:
  > `so far: jungle wood, sand haul, biome hopping, and now we're here in the plains.`
- DIARY.md L8 — the closest thing to praise that *did* survive, never surfaced in any reply:
  > `SSk1tz seemed satisfied when i dropped them at their feet, and there was this quiet moment where we both just stood there in the dirt together`

## ANALYSIS COMPLETE — memory.txt
