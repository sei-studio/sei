# Chess minigame (260710)

An in-app untimed chess game against the character, launched from the "Play
together" tiles. **Mutually exclusive with a Minecraft summon** per character.

- **Engine:** `vendor/cce-1` (public repo `sei-studio/cce-1`, AGPL-3.0) — the
  Character Chess Engine: Maia-3 ONNX (Elo-conditioned human move
  distributions, via onnxruntime-node) + tempered Gumbel-top-4 sampling +
  blunder/blinder layers + Stockfish WASM (bundled, 7 MB) + plain-language
  translation. The engine fixes STRENGTH; the LLM picks among 4 candidates and
  can only express STYLE. The 21 MB Maia model (`maia3-5m.onnx`, our own ONNX
  export of the official AGPL-3.0 Maia3-5M checkpoint from CSSLab/maia3, via
  cce-1 `scripts/export-maia3.py`) is NOT bundled — it downloads on first
  chess launch (`src/main/chess/modelStore.ts`, cce-1 GitHub release asset,
  cached in userData; dev machines use `~/.sei-dev/cce/`).
- **Service:** `src/main/chess/chessService.ts` owns the authoritative board
  (chess.js) + the LLM turn runner (chat-brain path, tools `play` /
  `propose_draw` / `forfeit`; illegal moves get a retry tool_result). Since
  260714 turns ride the game-agnostic FSM core (`src/bot/brain/fsm.js`, one
  queue per session): P1 player chat (consecutive sends coalesce into ONE
  reply turn), P2 `your_move` (the decision — atomic, never aborted or
  re-run), P3 idle ticks (sampled 25–90s with silent-streak backoff; the
  prompt says a line is optional and silence is normal). The decided move
  enters a presentation HOLD: a sampled prethink think-delay (cce-1 `think`
  signals: Maia policy entropy + candidate eval closeness → log-normal, so
  most moves answer fast with occasional tanks) before commentary +
  `pendingAiMove` present, then the renderer's 2s-quiet postthink gate
  (`useAiMoveReveal` settle window) before the ack commits. A player chat
  during the hold NEVER rolls the move back: the reply turn is told the
  queued move and can revise it (`play()` again, free — same cached
  candidates) or hold it back (`wait()`: pendingAiMove retracts, only player
  messages/idle ticks wake it, cap disarmed). A hard cap (4 reply cycles or
  45s, `CHESS_TIMING`) force-commits so chat spam cannot stall the game.
  Move prompts carry translated last-two-ply delta sentences + move number,
  never raw SAN history (the commentary-hallucination fix); table talk is
  optional (a silent `play()` ends the turn). Protocol contract:
  `src/shared/chessIpc.ts`.
- **Chat routing:** while a game is open, `chat:send` is handled by
  `handlePlayerChat` in the chess service (game-aware replies, queued at P1
  on the session FSM), not the standalone chat brain.
- **Profile:** per-character strength/style at `character.metadata.chess`
  (`{elo 400-2000, styleNote, source auto|user}`) — auto-derived from the
  persona by a one-off LLM call on first game
  (`src/main/chess/chessProfile.ts`), user-editable in Edit companion → Games.
- **UI:** `src/renderer/src/components/chess/` (board, panel, reveal-gating
  hook) + `useChessStore`; the board opens as a right-side panel inside
  ChatScreen, compressing chat to a narrow column.
- **Packaging:** onnxruntime-node ships all-platform prebuilds; per-OS `files`
  excludes in `electron-builder.yml` drop the foreign ones.
- **First-game friction (260929).** Real usage: 10 of 35 games ended at 0
  moves (some after minutes at the board) and players won 2 of 16 decided
  games. Four fixes, each with its own module and test:
  - The model download (`modelStore.downloadModelFile`) has a connect budget
    and a stall budget per attempt and walks the sources up to 3 times
    (`MODEL_DOWNLOAD`). A failed warm-up no longer ends the game: it stays
    `preparing` with `warmupError`, main pushes `pct: -1` with a CODE
    (`download_failed` / `engine_failed`, never the raw message), the panel
    shows friendly copy and Try again (`chessStart` on that game re-runs
    `warmUp`), and `surface_error model_download_<kind>` records why.
  - `chess_game_ended` carries `stage` (`downloading`, `download_failed`,
    `engine_failed`, `waiting_first_move`, `midgame`), `player_moves` and
    `nudges`, so a failed download no longer reads as a player quitting.
  - One in-character "your move" nudge per player turn (`turnNudge.ts`):
    after `nudgeFirstMoveMs` (20s) of quiet on the first move, or
    `nudgeMoveMs` (120s) later on. Quiet counts from the later of the turn
    start and the last chat line, so talking pushes it back. It rides the
    session queue as `sei:nudge` and runs an idle turn with a nudge note.
  - Adaptive strength (`chessDifficulty.ts`): a player loss drops that
    character's next game 100 Elo, a win raises it 50, within -600/+200 of
    the persona Elo and 400-2000 absolute. Stored per character in the
    profile config (`chess_elo_offsets`, main-owned), never on the character.
    Only `source: 'auto'` profiles adapt; a hand-set Elo plays as set.
    Draws, abandoned games and a resign before the player's third move
    (`minPlayerMovesForResign`, a way out rather than a result) leave it.
    `ai_elo` is the effective Elo; `ai_elo_base` / `elo_offset` ride along.
