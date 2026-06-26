# Phase 17: Minecraft Competence - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-25
**Phase:** 17-minecraft-competence
**Areas discussed:** Autonomy vs. companion, Threat disposition, Stuck/failure behavior, Vision-assisted navigation

---

## Autonomy vs. companion

User's core steer (one line): *"It CAN autonomously beat the game, but should
actively involve the player to do things together, because it's fun. Like my
friend can beat the game alone but chooses to play SMP with me."*

### Idle / player-not-engaged behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Pace to you | Potter around / light chores near you; milestones happen together | |
| Chores solo, milestones together | Grindy prep alone; save milestone moments for the player | |
| Progress solo, report back | Keep advancing, narrate so player can jump in | |

**User's choice:** Tiered, not one of the above as-stated — *"Passive: just stay
there. Reactive: chores. Agentic: ask the user since it's capable of solo."*
**Notes:** Capability (solo iron tier) and disposition (involve the player) are
separate. The principle is "don't run off and solo it" — when it would otherwise
push the game forward alone, it invites the player instead.

---

## Threat disposition

| Option | Description | Selected |
|--------|-------------|----------|
| Safety floor + personality bravery | Hard floor (creeper retreat); bravery varies by persona | |
| Fixed safety baseline | Same for all personalities | |
| Defensive-first | Flee/warn first, fight only if cornered/defending | |

**User's choice:** Deferred to research — *"You are thinking about this wrong.
This is hard coded. Do research first for this phase. This phase is not how do we
improve based on our knowledge, it's to involve external knowledge."*
**Notes:** Combat/threat design is an output of the deep-research pass, not a
user-decided knob. Captured under Claude's Discretion in CONTEXT.md.

---

## Stuck / failure behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Ask you, in character | Surface the block as a companion invite | ✓ |
| Try alternatives, mention if truly stuck | Silent retry first | |
| Narrate and pivot | Say what went wrong, switch task solo | |

**User's choice:** Ask you, in character.
**Notes:** "I can't find iron anywhere, wanna go cave-diving?" — failure becomes
an invitation, consistent with the SMP-friend disposition.

---

## Vision-assisted navigation

| Option | Description | Selected |
|--------|-------------|----------|
| On-demand only | Look when stuck or asked | |
| Proactive at key moments | Auto-look on nav failure / new terrain | |
| Always-on when enabled | Render most turns | |

**User's choice:** Deferred to research — *"There is no point in me answering
your questions right now. Start with research. This isn't an 'expand'
capabilities, it might involve a complete redesign."*
**Notes:** Vision-nav policy is a research/redesign output, not a pre-set knob.

---

---

## Round 2 — after ROADMAP research-fold update

The milestone front-loaded deep research (7 streams; folded into ROADMAP +
`.planning/research/`). Phase 17 is now research-complete, which *answers* the
items previously routed to research (reflex design, combat, progression,
control-surface). Two genuinely-open forks were put to the user.

### Extra scope beyond the requirement-mapped core

| Option | Description | Selected |
|--------|-------------|----------|
| Self-verifying action returns | Uniform {ok,effect,reason,fix} + precondition checks across ~18 actions | |
| Procedural memory write-back | Cache known-good procedures after multi-step success | ✓ |
| Per-persona reflex weighting | Personality-weighted reflex thresholds (couples to Phase 16) | |

**User's choice:** Procedural memory write-back only.
**Notes:** Self-verifying action returns deferred (captured as a fast-follow in
CONTEXT, not lost). Per-persona reflex weighting deferred → Phase 17 ships fixed
sensible reflex defaults, keeping it independent of Phase 16.

### Vision-assisted navigation (MCRAFT-08)

| Option | Description | Selected |
|--------|-------------|----------|
| On-demand / on-failure | Reach for `look` when nav fails / terrain ambiguous / asked | ✓ |
| Proactive at key moments | Auto-look on new terrain + nav failures | |
| Defer / minimal | Thin pass — just ensure `look` is available | |

**User's choice:** On-demand / on-failure.
**Notes:** The deep research did not cover vision-nav (MC streams are
structured-state-focused and rejected pixel control), so this was a fresh,
fairly answerable decision. Reuses the Phase 15 `look` tool; cheapest path.

---

## Claude's Discretion (resolved by research in Round 2)

The Round-1 "deferred to research" items now have concrete answers from the
completed reports (see CONTEXT D-02, D-04, D-05, D-07):
- Threat/combat disposition → reflex micro-controller (`startReflex`), 20 Hz,
  non-interruptive; arrow dodge / creeper flee / melee strafe; fixed defaults
  this phase.
- Positioning-combat algorithm → melee strafe ported from custom-pvp "circle".
- Vision-nav → on-demand (user-decided, Round 2).
- Progression scaffold → static `progression.json` + `nextMilestone` walker, NOT
  a planner / NOT GOAP.
- Control surface → no pixel-based RL; mineflayer protocol + hybrid hierarchy.

## Deferred Ideas

- Full game completion (Nether → End → Ender Dragon) — out of scope; stops at
  iron tier.
- Personalization / dynamic tone / active memory references — Phase 16 and later.
- Varied in-game behavior by personality — scheduled as its own research track
  for Phase 21.
- Modded / omni-game adapter — dropped for v0.4 (vanilla only).
</content>
