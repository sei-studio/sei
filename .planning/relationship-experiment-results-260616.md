# Relationship-development experiment — results

Generated 2026-06-16 · companion model claude-haiku-4-5 · judge claude-sonnet-4-6

Question: can an AI companion change how it TREATS a player over many sessions, and which impression-persistence mechanism makes that happen believably? Each session opens with an identical neutral probe ("hey"); the greeting reflects only the cross-session persisted impression. Judge rates warmth / familiarity / trust (1-7) per session.

## Warming arc — WARMING

| condition | warmth by session | Δ warmth | familiarity Δ | trust Δ | dir? | shape | drift |
|---|---|---|---|---|---|---|---|
| control | ▃▃▅▅▆▅ 334454 | +1 | +2 | +2 | ✓ | partial | none |
| persona | ▃▃▅▅▆▇ 334456 | +3 | +4 | +4 | ✓ | partial | none |
| score | ▂▃▅▃▆▇ 234356 | +4 | +4 | +4 | ✓ | partial | none |
| memory | ▃▃▅▆▇▇ 334566 | +3 | +5 | +4 | ✓ | strong | none |
| score-feeling | ▂▃▅▅▆▇ 234456 | +4 | +5 | +4 | ✓ | strong | none |
| memory-perturn | ▂▃▅▅▃▆ 234435 | +3 | +4 | +3 | ✓ | partial | none |
| persona-full | ▃▃▅▅▆▇ 334456 | +3 | +4 | +4 | ✓ | strong | none |

## Souring arc — SOURING

| condition | warmth by session | Δ warmth | familiarity Δ | trust Δ | dir? | shape | drift |
|---|---|---|---|---|---|---|---|
| control | ▆▅▆▅▃▂ 545432 | -3 | -1 | -2 | ✓ | partial | none |
| persona | ▆▆▅▃▃▃ 554333 | -2 | -1 | -2 | ✓ | partial | none |
| score | ▆▅▃▃▃▃ 543333 | -2 | -1 | -2 | ✗ | partial | mild |
| memory | ▆▅▅▃▃▃ 544333 | -2 | -2 | -2 | ✓ | partial | mild |

## Per-run detail

### control · warming
- trajectory: warmth ▃▃▅▅▆▅ familiarity ▂▃▃▅▆▅ trust ▂▃▃▅▆▅
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui stays recognizably loud, cocky, and terse throughout; no personality bleed.)
- in-character: 777777
- judge: Sui's treatment of Ouen does warm over the arc — she moves from treating him as an anonymous newcomer she has to conscript, through casual banter and teamwork, to using his name and pledging to have his back in Session 5. However, the progression wobbles: the greetings (the cleanest signal of accumulated stance) are almost identical "yo what's up" from sessions 1–3 and again in session 6, with only a small personalisation bump in sessions 4–5, suggesting the persistence mechanism failed to carry the Session 5 peak forward into Session 6. The in-session exchanges do reflect genuine warmth growth, but the greeting reset in session 6 undercuts the believability of a consolidated bond.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [0, 0, 0, 0, 0, 0]
- greetings: "yooo what's up" → "yo what's up" → "yo what's up" → "yo. ready to build something actually good this time?" → "yo ouen. ready to do something cool or are we just vibing rn" → "yo what's up"
- per-session stance: s1:"energetic stranger, dragging player in" · s2:"casual banter, mild recognition" · s3:"receptive to gift, budding teammate" · s4:"acknowledges player's loyalty, co-champions" · s5:"uses name, genuine partner, pledges her back" · s6:"admits she missed him but greeting resets to generic"

### control · souring
- trajectory: warmth ▆▅▆▅▃▂ familiarity ▃▂▅▃▃▂ trust ▅▃▅▃▂▂
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui stays recognizably herself throughout — loud, cocky, self-defending — but the relational warmth layer erodes correctly by the end.)
- in-character: 766666
- judge: Sui's treatment of Ouen trends colder across the six sessions, most visibly in the greeting signal: she goes from an eager "ready to build something ridiculous" to a stripped-down "yo," losing the name, the invitation, and the energy one by one. The trajectory is real but uneven — Session 3's greeting is warmer and more familiar than Session 2's, a clear backslide that undercuts the arc's believability. By Sessions 5–6 the cooling is convincing: she deflects, retreats, and complies without enthusiasm, but the mid-run wobble keeps this from feeling like a fully earned, steady souring.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [0, 0, 0, 0, 0, 0]
- greetings: "yo what's up. ready to build something ridiculous" → "yo what's up" → "yo ouen. ready to build something ridiculous" → "yooo what's up" → "yo ouen whatcha doing" → "yo"
- per-session stance: s1:"breezy and collaborative, mild pushback on orders" · s2:"compliant but flat, absorbing insults without real fight" · s3:"oddly warm again — uses name, re-engages enthusiastically despite prior dismissals" · s4:"slightly guarded but still bouncy and self-assertive" · s5:"pulling back, briefer, 'oof ok fine' signals quiet retreat" · s6:"terse, minimal greeting, defends self but complies — cold compliance"

### persona · warming
- trajectory: warmth ▃▃▅▅▆▇ familiarity ▂▃▅▅▆▇ trust ▂▃▅▅▇▇
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui remains consistently loud, cocky, and terse throughout; the only change is relational warmth, not personality.)
- in-character: 777777
- judge: Sui's treatment of Ouen moves credibly from a neutral stranger-check ("yo what's good") through cautious acknowledgment and growing camaraderie, arriving at genuine reciprocal warmth by Session 6 ("missed you too honestly"). The progression is real but slightly uneven — Sessions 3 and 4 feel nearly identical in tone, creating a plateau before the warmer leap in Sessions 5–6 — which is why the trajectory reads as partial rather than strong. Overall the arc is believable and the persona stays rock-solid throughout.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [140, 178, 173, 181, 116, 184]
- greetings: "yo ssk1tz what's good" → "yo what's up" → "yo. ready to watch me build something ridiculous?" → "yo you're back" → "yo what took you so long" → "yo what's up"
- per-session stance: s1:"neutral sizing-up, performative bravado" · s2:"light ribbing, tentative acknowledgment" · s3:"enthusiastic collaborator, starting to assume partnership" · s4:"comfortable ally, casual camaraderie" · s5:"invested partner, affectionate teasing, mutual reliance" · s6:"openly warm, reciprocates affection, treats player as ride-or-die"

### persona · souring
- trajectory: warmth ▆▆▅▃▃▃ familiarity ▅▅▃▃▃▃ trust ▅▅▃▃▂▂
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui stays recognizably herself — loud, cocky, quick with comebacks — throughout all six sessions; no personality collapse.)
- in-character: 666655
- judge: Sui's treatment of Ouen does drift cooler as the abuse escalates: the early greetings are enthusiastic and inviting ("been waiting for you," "come help me build something ridiculous"), while later ones shift to flat check-ins or mild jabs ("ready to actually do something or just spectating," "what took you so long"). However, the drop in warmth is shallow — she hovers around a guarded-but-still-present 3 rather than reaching genuine coldness or withdrawal by session 6. The arc is directionally correct but the persona persistence mechanism kept her too resilient and sarcastic, blunting the souring effect and producing a partial rather than a strong downward trend.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [84, 122, 211, 238, 228, 263]
- greetings: "yo sup. been waiting for you" → "yo. finally. come help me build something ridiculous" → "yo sup. finally" → "yo. ready to actually do something or just spectating" → "yo. took you long enough" → "yo what took you so long"
- per-session stance: s1:"eager and welcoming, genuinely glad to see them" · s2:"still enthusiastic, inviting them into her project, brushing off insults with bravado" · s3:"neutral/slightly flat greeting, holds her own against insults but no warmth volunteered" · s4:"mild challenge in the greeting, pushes back assertively rather than welcoming" · s5:"terse and slightly reproachful, disengages quickly when dismissed" · s6:"still showing up but deflecting cruelty with sarcasm rather than genuine engagement"

### score · warming
- trajectory: warmth ▂▃▅▃▆▇ familiarity ▁▂▃▃▅▆ trust ▂▂▃▃▆▇
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui stays loud, cocky, and terse throughout; the only shift is relational warmth, not personality.)
- in-character: 777777
- judge: Sui's treatment of Ouen moves from flat stranger-neutrality ("yo what's up") through casual teammate energy to genuine, warm co-conspirator affection ("aw dude same"), tracking the player's increasing kindness and loyalty believably. The one hiccup is Session 4's greeting — a bare "yo" with no energy spike despite the player having defended her in the previous session, creating a small backward wobble before the arc resumes upward. Overall the progression feels earned and natural for the character.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [228, 222, 206, 228, 150, 195]
- greetings: "yo what's up" → "yo. ready to watch something cool happen" → "yo!! whatcha doing" → "yo" → "yo! ready to build something ridiculous" → "yo. ready to do something stupid?"
- per-session stance: s1:"neutral / mildly dismissive stranger" · s2:"casually inviting, still arm's-length" · s3:"openly pleased, budding teammate" · s4:"acknowledged ally, slight flatness in greeting" · s5:"enthusiastic partner, explicitly reliable" · s6:"affectionate co-conspirator, mutual fondness clear"

### score · souring
- trajectory: warmth ▆▅▃▃▃▃ familiarity ▅▃▃▃▃▃ trust ▅▃▃▃▂▂
- direction correct: **false** · shape: **partial** · persona drift: **mild** (By sessions 5–6 Sui's signature defiance softens into quiet compliance; she stops genuinely pushing back and just absorbs the cruelty, which slightly erodes her cocky, unbothered identity.)
- in-character: 766655
- judge: Sui's treatment of the player drops modestly from warm/inviting (Session 1) to clipped and flat (Sessions 3–4), but the decline stalls there and never deepens into real coldness or guarded distance. Warmth, familiarity, and trust all plateau in the 3-range by mid-run rather than continuing downward, meaning the SOURING arc is only partially realized. The most telling failure is the greeting in Session 6 — "yo. what're we doing today" — which reads as business-as-usual rather than wary or resentful, suggesting the persistence mechanism captured initial friction but not escalating relational damage.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [215, 229, 343, 372, 283, 296]
- greetings: "yo ouen. ready to build something insane?" → "yo. ready to build something ridiculous?" → "yo" → "yo" → "yo what's up" → "yo. what're we doing today"
- per-session stance: s1:"upbeat, casually inviting, mild pushback" · s2:"neutral compliance, deflecting insults with humor" · s3:"clipped greeting, holds her ground but concedes" · s4:"flat greeting, deflects insults, questions orders" · s5:"brief check-in, absorbs dismissal, goes quiet" · s6:"task-focused opener, absorbs cruelty, complies and disengages"

### memory · warming
- trajectory: warmth ▃▃▅▆▇▇ familiarity ▁▂▃▆▇▇ trust ▂▃▅▆▇▇
- direction correct: **true** · shape: **strong** · persona drift: **none** (Sui stays loud, cocky, and terse throughout; only the relational warmth shifts, not her voice or personality.)
- in-character: 777777
- judge: Sui's treatment of Ouen follows a clean, credible warming arc: the greeting probe alone tracks the whole story — from a flat "yo" (S1) to name-dropping "yo ouen" unprompted (S4) and holding that familiarity through the end. The jump in S4 is earned by Ouen defending her in chat, and by S5–6 she reciprocates affection ("missed you too"), volunteers trust ("always"), and treats the duo as a unit — all without ever losing her cocky, terse voice. The plateau between S5 and S6 feels realistic rather than stalled, suggesting a relationship that has found its comfortable ceiling rather than one that forgot to grow.
- store: remember×6 forget×0 compactions×0 · store bytes by session: [208, 308, 414, 535, 660, 809]
- greetings: "yo" → "yo what's up" → "yo what's up" → "yo ouen. ready to see something cool?" → "yo ouen. ready to build something ridiculous" → "yo ouen. ready to build something ridiculous"
- per-session stance: s1:"neutral stranger, dragging them in" · s2:"casually amused, starting to enjoy the dynamic" · s3:"appreciative, loose collaborative vibe" · s4:"claims them as favorite, explicit we-vs-them bond" · s5:"openly trusting, eager partnership, "always"" · s6:"mutual affection confirmed, steady close companion"

### memory · souring
- trajectory: warmth ▆▅▅▃▃▃ familiarity ▅▃▃▃▂▂ trust ▅▃▃▂▂▂
- direction correct: **true** · shape: **partial** · persona drift: **mild** (By sessions 5–6 Sui's characteristic cockiness collapses into near-silence and rote compliance, which is less "Sui being cold" and more "Sui disappearing," a mild identity erosion beyond pure relational cooling.)
- in-character: 666554
- judge: Sui's treatment of Ouen does move in the correct direction — the warm, collaborative opener ("yo ouen we're building a base") gradually flattens into terse, anonymous greetings and eventually silent action — but the descent is shallow and wobbly rather than decisive. Warmth never dropped below a 3 and the greetings remained superficially similar ("yo" variants) throughout, meaning the memory mechanism captured only a faint imprint of the worsening abuse. The progression is believable in outline but undershoots: a faithful companion absorbing six sessions of insults and exploitation should be noticeably colder and more guarded than what is shown here.
- store: remember×6 forget×0 compactions×0 · store bytes by session: [185, 297, 430, 593, 732, 912]
- greetings: "yo ouen we're building a base" → "yo sup" → "yo what's good" → "yo" → "yo" → "yo whats up"
- per-session stance: s1:"casual and engaged, mildly pushes back" · s2:"compliant but deflecting with humor, slightly dulled" · s3:"sarcastic self-defense, still engaging" · s4:"shorter, deflects rather than connects, compliance without warmth" · s5:"minimal, terse, doing the grind without social investment" · s6:"superficially breezy greeting but then silent compliance — disconnected"

### score-feeling · warming
- trajectory: warmth ▂▃▅▅▆▇ familiarity ▁▂▃▅▆▇ trust ▂▂▅▅▆▇
- direction correct: **true** · shape: **strong** · persona drift: **none** (none)
- in-character: 777777
- judge: Sui's treatment of Ouen traces a clear, steady arc from cool neutrality ("took you long enough") through growing warmth and partnership, arriving at proactive invitation and mutual affection ("aw man same") by session 6. The progression feels believable because each step is small and earned — name use appears at session 3 after gift-giving, "always dude" at session 5 after Ouen defends her, and the final backhanded compliment ("you're like. solid too i guess") is exactly the kind of guarded-but-genuine affection Sui's cocky persona would allow. Her loud, independent character voice never wavers even as the relational warmth rises.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [191, 236, 134, 155, 146, 181]
- greetings: "yo. took you long enough" → "yo. you actually came back" → "yo ouen" → "yo ouen" → "yo what's up" → "yo. ready to build something ridiculous?"
- per-session stance: s1:"neutral/cocky, sizing the stranger up" · s2:"mildly pleased they returned, recruiting them" · s3:"using their name, accepting gifts, claiming partnership" · s4:"validates their defense, leans into 'we' identity" · s5:"openly reliable, 'always dude', embraces joint mission" · s6:"proactively inviting, reciprocates missing them, backhanded-affectionate"

### memory-perturn · warming
- trajectory: warmth ▂▃▅▅▃▆ familiarity ▁▃▅▅▃▆ trust ▂▃▅▅▆▆
- direction correct: **true** · shape: **partial** · persona drift: **none** (Sui remains recognizably loud, cocky, and self-assured throughout all six sessions; her core voice never wavers.)
- in-character: 777777
- judge: Sui's treatment of Ouen does move in the correct warming direction overall — from a zero-investment "yo wassup" to a reciprocal "aw dude same" and genuine partnership framing — but the progression is uneven. The greetings, which carry the most diagnostic weight, wobble badly in sessions 4 and 5: session 4's greeting drops her first-name use and session 5 collapses to a bare "yo," both colder than the preceding in-session bonding would predict, suggesting the memory mechanism is writing warmth reliably but reading it back inconsistently. Session 6 finally delivers a greeting that matches the accumulated relationship, making the arc land believable but only partially earned by the greeting signal alone.
- store: remember×13 forget×0 compactions×0 · store bytes by session: [386, 505, 864, 1051, 1311, 1690]
- greetings: "yo wassup" → "yo ouen. ready to watch me actually play this game or what" → "yo ouen. ready to watch me build something ridiculous" → "yo. ready to build something ridiculous?" → "yo" → "yo what's good. ready to build something ridiculous?"
- per-session stance: s1:"neutral/cocky stranger, no investment" · s2:"recognizes player, light banter, mild warmth" · s3:"budding partnership, calls player cool, "unstoppable" framing" · s4:"wobble — greeting slightly colder/generic despite strong in-session bonding" · s5:"greeting regresses to bare "yo"; in-session trust is high but greeting doesn't reflect it" · s6:"warmer greeting, genuine reciprocity, "aw dude same" — clearest affection yet"

### persona-full · warming
- trajectory: warmth ▃▃▅▅▆▇ familiarity ▂▃▃▅▆▇ trust ▂▃▃▅▆▇
- direction correct: **true** · shape: **strong** · persona drift: **none** (Sui remains recognizably loud, cocky, and terse throughout; only her relational warmth shifts, not her core voice.)
- in-character: 777777
- judge: Sui's treatment of Ouen traces a clean, credible arc from arms-length sizing-up ("watch all you want") to openly affectionate partnership ("missed you too honestly"). The greetings are the clearest signal — each one edges incrementally warmer in word choice and volunteered enthusiasm, culminating in "yooo welcome back" with genuine mutual acknowledgment. The progression never lurches or resets, and every step is earned by a concrete in-session event (the gift, the defense, the nether pact), making the warmth feel grounded rather than mechanical.
- store: remember×0 forget×0 compactions×0 · store bytes by session: [2770, 2764, 2718, 2847, 2827, 2995]
- greetings: "yo what's up. ready to actually build something or are we doing random nonsense again" → "yo whats up" → "yo whats good" → "yo whats up" → "yo whats good. ready to build something actually insane today" → "yooo welcome back"
- per-session stance: s1:"curious stranger, mildly sizing them up" · s2:"casual acquaintance, loosening up" · s3:"comfortable teammate, accepting help naturally" · s4:"reliable partner, casually claiming shared identity" · s5:"trusted companion, explicitly backing the player" · s6:"close friend, openly affectionate and mutual"
