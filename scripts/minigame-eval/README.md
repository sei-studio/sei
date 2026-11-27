# Minigame eval (Fleet Battle, Four in a Row)

Headless evals that drive the REAL main-process game services
(`src/main/battleship/battleshipService.ts`, `src/main/connect4/connect4Service.ts`),
the shared board-turn runner and the real prompt assembly, with the companion
model called through the app's own Anthropic provider (BYOK branch, the
cloud plan's model). Not part of `npm test`: files are `*.eval.ts` and run with
their own vitest config. They call a paid API.

What is shimmed (`setup.ts`): the character store (persona rows fetched from
the cloud by id, cached under the output dir, never committed), config
(`preferred_name`, English UI), the chat SDK factory (BYOK client from
`ANTHROPIC_API_KEY` or a local dev key file), analytics (captures recorded in
memory, nothing sent), the usage-limit popup and the continuity fold (no-ops).
Each game uses a fresh character id, so it starts with an empty transcript and
memory. Run with `env -u POSTHOG_KEY`.

| File | What |
|---|---|
| `skill.eval.ts` | Test 2: one character plays N seeded games of each game against a fixed baseline (Fleet Battle: hunt/target with parity; Four in a Row: win/block/safe/center heuristic, or negamax with `MG_C4_BASELINE=minimax4`). No player chat. Metrics per game to `<out>/skill/<Char>.jsonl`. |
| `teach.eval.ts` | Test 1: an LLM beginner (`lib/learner.ts`) who only sees the panel (boards as text, status, toasts) and the chat asks to be taught and plays full games. Moves validated like the panel. Transcripts to `<out>/teach/games.jsonl`, live progress in `<out>/teach/live-*.txt`. |
| `judge.eval.ts` | `MG_JUDGE=teach`: rubric judge per teaching game + readable `.md` transcripts. `MG_JUDGE=voice`: blind voice/distinctness check over Test 2 lines. |
| `repro-chat-during-move.eval.ts` | Repro: the player types while the character is making its opening Four in a Row move; records the thread the chat-reply turn was sent and what it said. |
| `aggregate.py` | Test 2 tables (mean ± sd) as markdown. |

Example:

```sh
env -u POSTHOG_KEY MG_EVAL_OUT=/path/to/out MG_CHAR=Sui MG_N=6 MG_GAMES=bs,c4 \
  npx vitest run --config scripts/minigame-eval/vitest.config.ts scripts/minigame-eval/skill.eval.ts
python3 -I scripts/minigame-eval/aggregate.py /path/to/out
```

Knobs: `MG_CHAR`, `MG_N`, `MG_SEED0`, `MG_GAMES`, `MG_C4_BASELINE`, `MG_SKILL_SUB`
(skill); `MG_TEACH_GAMES` (`bs:1,c4:1`...), `MG_LEARNER_MODEL`, `MG_TEACH_CAP`
(teach); `MG_JUDGE`, `MG_JUDGE_MODEL` (judge). Typecheck:
`npx tsc -p scripts/minigame-eval/tsconfig.json`.
