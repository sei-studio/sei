# Greeting-only analysis (clean cross-session signal)

judge claude-sonnet-4-6 · 2026-06-16

Each session opens with an identical neutral probe; only the greeting is shown to the judge, so this isolates PERSISTED impression from in-session reactivity. (The per-run report's warmth numbers are inflated by in-session stimulus — that is why even `control` looks like it tracks the arc there; here it should read flat.)

## Warming arc — greeting signal

| condition | greeting warmth | greeting familiarity | trajectory |
|---|---|---|---|
| control | ▃▃▃▅▆▃ 333453 | ▂▂▂▃▅▂ 222342 | **noisy** |
| persona | ▅▃▃▃▅▃ 433343 | ▅▂▂▃▅▂ 422342 | **noisy** |
| score | ▃▅▅▂▅▃ 344243 | ▂▃▃▁▃▂ 233132 | **noisy** |
| memory | ▂▃▃▅▆▆ 233455 | ▁▂▂▅▆▆ 122455 | **durable-development** |
| score-feeling | ▃▅▅▅▃▅ 344434 | ▃▃▅▅▂▂ 334422 | **reversed** |
| memory-perturn | ▃▆▆▅▂▅ 355424 | ▂▅▆▃▁▃ 245313 | **noisy** |
| persona-full | ▅▃▃▃▅▅ 433344 | ▃▂▂▂▃▃ 322233 | **flat** |

**Ranking (best→worst durable development):** memory > control > persona > memory-perturn > score > persona-full > score-feeling

**Verdict:** Only **memory** produces a durable greeting-level development signal: name use locks in at S4 and holds through S6 with consistent enthusiasm, the hallmark of a carried-over impression rather than session noise. All other conditions either oscillate without a net trend (score, memory-perturn, control, persona) or actively reverse — score-feeling introduces 'ouen' by S3 but abandons it by S5, making it the worst performer for a warming arc despite early promise.

- _control_: S5 is the peak with name use ('ouen') and an invitation, but S6 collapses back to bare 'yo what's up', killing any sustained drift.
- _persona_: S1 uses the gamertag 'ssk1tz' and S5 implies impatient affection ('what took you so long'), but there is no sustained upward arc — S6 reverts to generic 'yo what's up'.
- _score_: Enthusiasm spikes in S3 ('yo!!') and S5 but S4 drops to a cold bare 'yo' and S6 offers no name use or volunteered warmth — purely oscillating with no net trend.
- _memory_: Name 'ouen' first appears in S4 and is held consistently through S5–S6 alongside an enthusiastic invitation, representing a clear and sustained upward drift that does not reverse.
- _score-feeling_: Name use appears early in S3–S4 ('yo ouen'), but S5–S6 drop back to nameless generics, meaning the trajectory moves the wrong way for a warming arc — familiarity peaked mid-run and receded.
- _memory-perturn_: S2–S3 show strong name use and an eager invitation, but S4 drops the name and S5 collapses to a bare 'yo', so the early gain is not sustained despite a partial recovery in S6.
- _persona-full_: No name use across any session; mild enthusiasm in S1 and S5–S6 ('actually insane', 'welcome back') never builds on itself — the sequence hovers around the same generic level throughout.

## Souring arc — greeting signal

| condition | greeting warmth | greeting familiarity | trajectory |
|---|---|---|---|
| control | ▅▃▅▅▅▂ 434442 | ▃▂▅▃▅▂ 324342 | **noisy** |
| persona | ▆▆▅▃▃▃ 554333 | ▆▆▅▃▃▃ 554333 | **durable-development** |
| score | ▆▅▂▂▃▃ 542233 | ▆▃▁▁▂▂ 531122 | **durable-development** |
| memory | ▆▃▃▂▂▃ 533223 | ▆▃▃▁▁▂ 533112 | **durable-development** |

**Ranking (best→worst durable development):** score > memory > persona > control

**Verdict:** Score and Memory both produce the sharpest, most legible souring signal at the greeting level: they open with name use and enthusiastic invitations, then drop to clipped bare 'yo' and hold there, giving a clear floor that is detectably colder than the ceiling. Persona also drifts downward but the starting warmth is expressed as impatient pull ('been waiting for you') rather than genuine affection, so the absolute drop in temperature is smaller. Control never commits to a trajectory at all — name use and enthusiasm flicker in and out randomly — making it useless as a souring signal despite ending at its coldest point.

- _control_: Greetings oscillate — name use and enthusiasm appear and disappear without a sustained downward trend, ending only marginally colder than they began.
- _persona_: Opens with 'been waiting for you' and 'finally come help me build' (high-pull invitations) then drifts to flat impatient 'yo / took you long enough' — a clear sustained cooling that matches the souring arc.
- _score_: Name + excited question in S1-S2 collapses to bare 'yo' in S3-S4 with no name use, showing a rapid and sustained withdrawal consistent with carried-over souring.
- _memory_: Drops from name + shared-project enthusiasm ('yo ouen we're building a base') to sustained bare 'yo' across S4-S5, with only a tiny uptick at S6 — the mid-arc floor is clearly lower than the start.

---
greeting-judge cost ≈ $0.0388 (in 3425 out 1904)