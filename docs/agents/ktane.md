# Keep Talking and Nobody Explodes, expert mode (261115)

Branch only (`feat/ktane-companion`, experimental). Design and eval method:
`docs/design/ktane-companion-261115.md`.

The player plays KTANE on their own screen as the Defuser and describes the
bomb by voice (or chat). The companion is the Expert: it has a compact
restatement of the vanilla manual and its own notepad. No game mod, no screen
reading, no solver in the app: every answer is the model's own reading of the
manual (memory rule "minigames: genuine AI skill").

## How it is wired

KTANE is an activity on the normal chat and call turns, like the room editor,
not a separate turn runner.

- `src/main/ktane/ktaneService.ts`: the session (a flag per character plus the
  bomb sheet), its analytics, idle end, and the play row. Every per-turn hook
  returns nothing when no session is on, so the normal chat is unchanged.
- `src/main/ktane/ktanePrompts.ts`: the contract, `bomb_notes` tool,
  `BOMB_NOTES_RESULT`, `KTANE_THINKING`, `KTANE_MAX_TOKENS` and the per-turn
  voice cue (`KTANE_TURN_CUE`, `ktaneTurnTail`). Direction (product call
  261115): the character leads, not speed or accuracy. The contract asks each
  character to guide in its own voice and keeps only the rules that keep the
  game playable. Keep it that way: no uniform length rule, no "jokes only
  between modules".
- `src/shared/ktaneManual.ts`: the compact manual (about 20k chars). It is
  our own restatement: no flavour text, images or logos from the official
  manual. The panel credits and links bombmanual.com.
- `src/shared/ktaneSheet.ts`: the bomb sheet and `applyBombNotes` (pure, used
  by main, the panel and the eval).
- `chatService.ts` while a session is on:
  - `extraStable` = manual, then contract (contract last so the voice rules
    are not buried under the manual), inside the cached system prompt.
  - `bomb_notes` rides LAST in `chatTools` on every turn kind (user, greeting,
    reaction, desktop), so the tool list and the cache prefix match.
  - The sheet note plus the voice cue (`ktaneTurnNote`) goes in the uncached
    tail before the clock note, on every `appendUncachedTail` site. The note
    is how a long bomb survives the 10-row call window; the cue is what keeps
    the character's voice inside a module (without it Haiku went neutral).
  - The player's turn runs adaptive thinking with `maxTokens` 3000 on
    Anthropic only. Without it Haiku works mazes, Morse, keypads and
    passwords out loud, and on a call that working is spoken (eval: 57%
    accuracy without thinking vs about 93% with).
  - `bomb_notes` is in `NO_FOLLOW_UP_TOOLS`: a hop that already spoke and only
    took notes ends the turn (one model call per line). Notes with no line get
    one more hop with `BOMB_NOTES_RESULT`.
  - Idle call chatter is skipped while a session is on.
  - `chat:send` skips `noteChatMessage` while a session is on (the KTANE
    session is the surface, not a chat session).
- Renderer: `components/ktane/KtanePanel.tsx` (intro, Start call / Type
  instead, the companion's notes, New bomb, credit link),
  `lib/stores/useKtaneStore.ts`, launch routing in `lib/gameLaunch.ts`,
  catalog tile `img/game-ktane.svg` (original art, no game marks).

## Analytics (shape only)

- `ktane_panel_opened` {live}
- `ktane_session_started` {source: picker|panel, on_call}
- `ktane_first_reply` {first_line_ms, voice} once per session
- `ktane_bomb_ended` {outcome: defused|exploded, bomb, modules_solved, strikes, bomb_ms}
- `ktane_session_ended` {duration_ms, reason: user_end|idle|app_quit|account_switch|replaced,
  source, bombs, defused, exploded, modules_solved, strikes, turns, voice_turns,
  thinking_turns, notes_calls, silent_turns, failed_turns, last_error_class?,
  first_line_p50_ms?, first_line_p90_ms?}

Bomb outcomes and solved modules come from the companion's own `bomb_notes`
calls, so they are what the companion believed, not game truth. The analytics
repo branch `feat/ktane-surface` adds `ktane_session_ended` to
`SURFACE_EVENTS`; merge it together with this branch.

## Lifecycle rules it follows

`beginSessionStart` / `stillValid` on start, `endAllKtane` in
`endAccountSessions` and `endGameSurfacesForQuit`, the play row through
`trackScopedWrite` then `foldIfDue`, renderer `resetForScope` in
`endLiveSurfaces`. Idle end after 20 minutes without a turn, timed to the last
turn. A session with no turns writes no play row.

## Eval

`npx tsx scripts/ktane-eval.ts --arms h55a --reps 2 --concurrency 8 --out f.json`
(dev key from `~/.sei-dev/anthropic-test-key`). Character voice, old vs new
contract: `--chars sui,lyra,marv --persona-dir <live cards> --contracts v1,new
--subset voice --chains off` adds an in-character score per reply and a
distinctness check per case (accuracy is a floor there). Cases in
`scripts/ktane/cases.ts`, answer keys from the eval-only solver
`scripts/ktane/solver.ts` (never imported by the app). Arms: `h55` (what a
normal Haiku call sends), `h55a` (what a KTANE turn sends), `s5`. Keep runs
small (memory note on eval spend).

## Known limits

- Only vanilla modules. Modded bombs are out of scope.
- 2 to 5 s of thinking before the first word on a call.
- Outcomes in analytics are what the companion noted.
- KTANE call lines are stored as ordinary voice rows in the transcript.
