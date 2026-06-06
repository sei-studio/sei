# Phase 2: Two-Layer LLM Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in 02-CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 02-two-layer-llm-loop
**Areas discussed:** Tool-calling + hand-off shape, Idle observations + hop/abort policy, Ollama fallback + persona config, Dev/test affordance

---

## Tool-calling + hand-off shape

### Q: How should the movement LLM (Qwen) invoke registry actions?
| Option | Selected |
|---|---|
| Native Ollama tool-calling (Recommended) | ✓ |
| Strict JSON mode | |
| Text-tag protocol (mindcraft style) | |

### Q: What shape does the personality→movement hand-off take?
| Option | Selected |
|---|---|
| Free natural-language prose (Recommended) | ✓ (with caveat) |
| Structured intent object | |
| Free prose + forbidden-token filter | |

**User's note:** "We will use free natural-language prose for now, but we're not 100% certain about the small local model's ability to translate intent to actions. So we will make a note to experiment with specific action commands in future test branch."

### Q: How is the action registry exposed to Qwen at call time?
| Option | Selected |
|---|---|
| All actions every call (Recommended for v1) | ✓ |
| Personality-pre-filtered subset | |
| Two-tier bundles | |

---

## Idle observations + hop/abort policy

### Q: How does the personality LLM decide what (and whether) to comment on at the 10s idle tick?
| Option | Selected |
|---|---|
| Cheap gate-call first (Recommended) | |
| Always-fire LLM, rate-limited | |
| Curated trigger set, no idle LLM | |
| **Other (user-defined)** | ✓ |

**User's freeform answer (verbatim):**
> "I don't want this to be too complicated so try to keep it simple. I want the model to decide between three actions during an idle tick. The model should maintain a couple selected long term goals it sets for itself like (get wood, get iron) that it does for fun and a couple goals given by me (kill cows etc). During an idle tick, the model should check if there's goals by me, if so do actions to carry those out (HEARTBEAT to make her alive for tasks essentially), else, pick what she wants to do herself and just play the game. during this process, she can still choose to comment like on what she sees while executing tasks. finally, the players direct in chat instruction to follow them overrides all tasks. Think about how to design this simply."

**Captured as:** D-06 through D-10 (two in-memory goal lists, prompt-driven prioritization, FSM-native chat override).

### Q: Who can add/remove goals from the two lists?
| Option | Selected |
|---|---|
| Both: owner via chat, bot autonomously (Recommended) | ✓ |
| Owner adds owner_goals only; self_goals seeded once | |
| Owner-only — no self_goals in Phase 2 | |

### Q: Should goals persist across bot restarts in Phase 2?
| Option | Selected |
|---|---|
| In-memory only (Recommended) | ✓ |
| Quick JSON file dump | |

### Q: What counts as one 'hop' against the 5-hop recursion cap?
| Option | Selected |
|---|---|
| Each LLM call counts (Recommended) | ✓ |
| Each personality cycle counts | |
| Each event-chain counts | |

### Q: What happens when the 5-hop cap is reached mid-event-chain?
| Option | Selected |
|---|---|
| Bot says something in-character + log (Recommended) | ✓ |
| Silent stop + log only | |
| Pause cycle for N seconds | |

---

## Ollama fallback + persona config

### Q: When/how does the system switch from Qwen to Haiku-as-executor (LLM-08)?
| Option | Selected |
|---|---|
| Startup probe + on-error switch with circuit breaker (Recommended) | ✓ |
| Startup probe only | |
| On-error switch only, no startup probe | |

### Q: Where do name / backstory / tone live?
| Option | Selected |
|---|---|
| Extend config.json (Recommended) | ✓ |
| Separate persona.json | |

### Q: What forms the cached Anthropic prompt prefix (PERS-05)?
| Option | Selected |
|---|---|
| system + persona + tool definitions (Recommended) | ✓ |
| system + persona only; tools per-call | |
| system only | |

---

## Dev/test affordance

### Q: How do we iterate on the FSM↔LLM wiring without burning Anthropic tokens every dev run?
| Option | Selected |
|---|---|
| Mock LLM mode + Ollama-only dev mode (Recommended) | |
| Recorded transcript replay | |
| No special test affordance — budget a small Haiku spend | ✓ |

### Q: What does 'mock LLM mode' need to support in this phase?
| Option | Selected |
|---|---|
| Scripted responses + scenario harness | |
| Just stub returns; no harness | |

**User's note:** "N/A" — moot once mock mode was declined.

---

## Claude's Discretion
- Exact Ollama/Anthropic timeout values
- Debounce mechanism (500ms requirement is fixed)
- Hop counter storage
- In-character "cap hit" line phrasing
- Internal `src/` module layout
- `setGoals` action's exact Zod shape

## Deferred Ideas
- Goal persistence (→ Phase 3, MEM-04)
- Hot-reload persona (→ Phase 4)
- Mock LLM layer + scenario harness
- Recorded transcript replay
- Per-call action filtering
- Structured-intent hand-off (test-branch experiment, contingent on Qwen NL reliability)
- Manual Ollama recheck command
