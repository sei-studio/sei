# Connect 4 reuse notes — the generalization probe (260720)

Connect 4 is game #2 after chess, built deliberately by cloning the chess
architecture file-by-file and recording what copied verbatim, what diverged,
and where chess assumptions leaked. This document is the input for extracting
a turn-based game SDK before game #3.

Scale of the clone: chessService.ts is 1403 lines, connect4Service.ts is 1234.
Roughly 70 percent of the service is a mechanical copy with identifiers and
move types renamed. The renderer clone ratio is similar.

## A. Files copied nearly verbatim, and their deltas

| New file | Cloned from | Diff-worthy deltas |
|---|---|---|
| `src/shared/connect4Ipc.ts` | `chessIpc.ts` | Move = `{ col }` int, not UCI string. No `drawOffer`, no `'preparing'` status, no download progress type. Added `line` (winning cells) to the result for board highlight. Board array ships in the snapshot (chess ships FEN, a string). |
| `src/main/connect4/connect4Service.ts` | `chessService.ts` | ~70% verbatim: session map, FSM queue wiring (P1 chat coalescing / P2 your_move / P3 idle w/ silent-streak backoff), presentation hold (prethink sampler, wait()/revision, reply-cycle + wall-clock force-commit cap), chat takeover, illegal-move retry tool_result, connection-error retry + candidate fallback, endSession transcript event + MEMORY.md line, `describeErr`/`isConnectionError` copied byte-for-byte. Deltas: engine is synchronous pure JS (no warm-up block, no modelStore, no download pushes); no draw machinery (propose_draw tool, drawOffer state, drawDeclinedNote all deleted); `tryParseMove` (SAN+UCI) became `tryParseCol` (1-based int); prethink signals are `closeness/forced` instead of Maia entropy/eval-gap; `snapshot()` deep-copies board+history (chess shares live refs, see C3). |
| `src/main/connect4/connect4Profile.ts` | `chessProfile.ts` | Same shape and flow (Zod schema at `metadata.<game>`, one-off LLM derivation with a forced tool call, never-throw fallback, persist via patchCharacter). Deltas: `strength 1-5` instead of `elo 400-2000`; fallback consults `metadata.chess.elo` via `strengthFromChessElo()` so the two games agree on sharpness. |
| `src/main/connect4/connect4Service.test.ts` | `chessService.test.ts` | Same mock set minus modelStore/cce-1 (engine is real in tests). Same scenario list; added AI-moves-first and four-in-a-row/forfeit endings; dropped draw scenarios. |
| `src/renderer/src/lib/stores/useConnect4Store.ts` | `useChessStore.ts` | Verbatim minus the chess board-UI state (arrows, circles, flip, promotion picker, viewPly scrubbing). `revealed` keys a column int, not a UCI string. REVEAL_ANIM_MS 480 (falling disc) vs 320 (slide). |
| `src/renderer/src/components/connect4/useAiDropReveal.ts` | `useAiMoveReveal.ts` | Verbatim except the pending-move key type. THE most copy-pastable file in the whole clone; zero game knowledge beyond "a pending move id". |
| `src/renderer/src/components/connect4/Connect4Panel.tsx` | `ChessPanel.tsx` | Shell verbatim: header (avatar/name/skill chip/status/close), pre-game seat-pick card, result banner, resign inline confirm, MC-conflict modal with the same disconnect-and-retry flow. Deltas: no download card, no draw banners, no move list/captured material; "Elo ~900" chip became "Level 3/5". |
| `Connect4Panel.module.css` | `ChessPanel.module.css` | Verbatim minus chess-only sections. Even the shimmer keyframes are copies. |
| `src/renderer/public/img/game-connect4.svg` | `game-chess.svg` | Same palette/composition language, new subject. |

New files with no chess counterpart:
- `src/main/connect4/rules.ts` — pure board functions (chess outsources this
  to chess.js).
- `src/main/connect4/engine.ts` — the strength-fixing candidate generator
  (chess outsources this to vendor/cce-1).
- `Connect4Board.tsx/.module.css` — genuinely game-specific rendering.

## B. What belongs in a shared SDK core

Proposed package: `src/main/tablegame/` (main-side core) + renderer twins.

1. **TurnGameSession<TMove, TBoardState> runtime** (from connect4Service):
   session map, FSM queue construction, chatBuffer + coalescing, the entire
   HoldState lifecycle (beginHold/presentHold/forceCommit/commitAiMove
   skeleton, cap timers, wait()/revision semantics), endSession (transcript
   event + memory line), error retry + fallback, `describeErr`. This is the
   70 percent. The game plugs in via an adapter interface:

   ```ts
   interface TurnGameAdapter<TMove, TState> {
     id: string;                    // 'chess' | 'connect4'
     displayName: string;           // 'Connect 4' (transcript + memory copy)
     createInitial(seatChoice): TState;
     turnOf(state): Seat;           // whose move on the committed state
     applyPlayerMove(state, move): { ok, error? } // mutate/validate
     applyAiMove(state, move): void;
     checkGameOver(state): Result | null;
     candidates(state, profile): CandidateOut;    // engine call (async ok)
     parseMove(state, rawToolInput): TMove | null;
     describeMove(move): string;                  // "column 4" / "Nf3" for tool_results
     describeRecentPlies(state, n): DeltaSentence[]; // translated deltas
     promptBlock(state, kind, playerName, extras): string; // or compose from parts
     tools(kind, holdActive): Tool[];             // play/wait/forfeit + game extras
     prethinkSignals(candidateOut): { difficulty: 0..1, forced: boolean };
     snapshot(state): SerializableState;          // MUST deep-copy
   }
   ```

2. **Profile derivation helper** (from chessProfile/connect4Profile): one
   generic `deriveGameProfile(characterId, schema, toolSpec, fallback)`; the
   two existing files differ only in schema + prompt text.

3. **Renderer game-store factory** (from useChessStore/useConnect4Store):
   `createGameStore<TState, TPendingKey>(api)` covering games/panelIntent/
   revealed/starting/hydrated + applyState reveal-keeping + HMR teardown.
   Game-specific UI state (chess arrows etc) stays in a per-game slice.

4. **useAiMoveReveal** as-is, parameterized on the pending key. Already
   game-agnostic; it never once referenced chess.

5. **Wiring generators**: the IPC handler block, preload members, and shared
   channel map are pure boilerplate keyed on the game id (8 handlers each).
   A `registerTurnGameIpc(gameId, service)` helper would collapse ~120 lines
   per game to one call. Same for the RendererApi surface if we accept a
   generic `game:<id>:<verb>` channel scheme.

6. **Launch metadata on GameDef** (renderer): `launch: 'panel' | 'summon'`
   plus an `openPanel(characterId)` hook, replacing the per-game `if (g.id
   === 'chess')` branches in GamesPickerModal and GameAboutModal (both now
   carry a second branch and an SDK note).

7. **ChatScreen game aside**: already generalized minimally this pass (one
   aside renders whichever game is open; chess wins a tie). SDK version: a
   registry of open-panel selectors.

## C. Where chess assumptions leaked and had to be worked around

1. **UCI-string move identity.** The reveal/ack protocol keys on the move
   value itself (`ackReveal(characterId, uci)`); chess UCI strings are
   near-unique per position, but a Connect 4 column repeats constantly. The
   ack guard survives because the hold gates it, but the identity should be a
   per-decision token, not the move value. (Kept the chess shape for parity;
   flagged for the SDK.)
2. **`'preparing'` status + download progress are chess-only** (Maia model
   download). The status union, the pre-flight warm-up IIFE in startChess,
   and the pushDownload dep all vanish for a pure-JS engine. SDK: make engine
   warm-up an optional adapter capability.
3. **Snapshots share live references.** chessService's `snapshot()` returns
   `history: s.history` (the live array). Over IPC the structured clone hides
   it, but any in-process consumer sees pushed snapshots mutate afterwards;
   the cloned connect4 service test caught this within the hour (a stale
   pending push "grew" a matching history and acked the wrong turn).
   connect4Service deep-copies; chessService still has the latent hazard.
4. **Draw machinery is entangled with the turn runner.** propose_draw handling
   sits inside the tool-dispatch loop, drawOffer inside the state model, and
   "moving declines the offer" inside playerMove/commitAiMove. Deleting it
   touched five separate regions. SDK: game-specific tools + state extensions
   need a declared extension point, not inline branches.
5. **Mutual exclusion is one-directional in chess.** chessStart refuses while
   summoned, but nothing stops a summon while a chess game is open (the
   renderer confirm is the only guard). Connect 4 adds the reverse guard in
   the `bot.summon` IPC handler (ends the board 'abandoned' before the
   summon). Chess should adopt it; SDK: a central "character is busy with X"
   registry.
6. **Service init lives in main/index.ts for chess.** initChessService is
   wired in index.ts with window closures. Because index.ts was concurrently
   owned by another change, connect4 initializes inside registerIpcHandlers
   (broadcast via BrowserWindow.getAllWindows()). It works and needs no
   index.ts edit, which is itself the SDK lesson: game service DI should ride
   IPC registration, not the app bootstrap. Corollary: connect4 has no entry
   in the index.ts shutdown path (chess calls shutdownChess there); harmless
   today (timers die with the process) but the SDK should own a shutdown-all.
7. **`inFlightKind` is never set in chessService.** Its onPreempt checks
   `s.inFlightKind === 'idle'` to abort in-flight idle turns, but no code
   path assigns it (the abort never fires; a latent chess bug). The connect4
   clone sets it in runC4LlmTurn. Chess should be patched.
8. **The aside CSS class is named `chessOpen`/`chessAside`** in
   ChatScreen.module.css and now hosts both games (renamed usage would churn
   the concurrent chess work; left as-is with a comment).
9. **Synchronous engine latency budget.** cce-1 is async (ONNX); the naive
   port made candidate generation a 4.5s synchronous main-process block at
   strength 5 until the search got a targeted last-move win test + depth cap
   (now < 1s worst case). SDK: `candidates()` must be async by contract and
   heavy engines belong in a worker.

## D. Estimated marginal effort for game #3 (say, checkers or gomoku)

Without extraction (repeat this clone):
- Service + profile + shared contract clone-and-adapt: ~1 day, high care
  (the hold/ack/coalesce logic is subtle and every rename is a chance to
  introduce a state-machine bug; the snapshot-aliasing bug cost an hour and
  only surfaced because the test suite was cloned too).
- Rules + engine: 0.5-1.5 days depending on the game's tactics.
- Renderer store + reveal hook + panel + board: ~1 day.
- Wiring (ipc/preload/shared/games/picker/about/ChatScreen): ~0.5 day, six
  shared-file edit sites each a merge-conflict magnet.
- Tests: ~0.5 day (clone + adapt).
- Total: **3.5 to 4.5 days**, and a third copy of the 70 percent to keep in
  sync (a fix like the summon guard or inFlightKind now needs 3 edits).

With the extraction (build the SDK from chess+connect4 first, ~2-3 days of
refactor risk against the working pair):
- Game #3 writes: rules, engine, board component, prompt fragments, profile
  schema text, a GameDef entry, one adapter object. Everything else is the
  core + factories.
- Total: **1 to 1.5 days**, and shared-logic fixes land once.
- Break-even is immediately at game #3, and the extraction also retires the
  three known latent chess bugs (C3, C5, C7) in one place.

## Verbatim-copy inventory (for the extraction diff)

Byte-identical or near-identical blocks now living in two places
(chessService.ts <-> connect4Service.ts): `describeErr`, `isConnectionError`,
`flushChatBuffer`, `sampleIdleDelayMs`, `gaussian`, `armCapTimer`,
`clearHoldTimers`, `presentHold`, `forceCommit`, the dispatch trio
(`dispatchYourMove`/`dispatchChat`/`dispatchIdle`), `handlePlayerChat`, the
LLM-turn scaffolding (system-block assembly, message tail, abort/stale/timeout
plumbing, speak/deferSpeech, remember handling, hop loop), `readMemoryTail`,
and `endSession`. Renderer: the whole reveal hook, ~80 percent of the store,
~85 percent of the panel CSS.
