# Forza 4 minigame (Connect Four)

An in-app, untimed Connect Four game (board 6x7, win 4 in a row horizontal/vertical/diagonal, draw on full board) against the character, launched from the "Play together" tiles. **Mutually exclusive with a Minecraft summon** per character (enforced by gameLaunch + isSummoned gate).

- **No engine, no model download.** The character picks its column via the LLM calling a `play(column)` tool (columns 0-6). If the model does not produce a legal column, the first free column is played so the game never stalls (`CONNECT4_MAX_HOPS=5`, `TURN_TIMEOUT_MS=90000`).
- **Service:** `src/main/connect4/connect4Service.ts` owns authoritative state (one session per character, `sessions` Map), move validation, win/draw detection, and the `play`/`remember` tool runner. Protocol contract: `src/shared/connect4Ipc.ts`.
- **Analytics / instrumentation:** `CONNECT4_game_started` (character_id, player_color, ai_color) and `CONNECT4_game_ended` (duration_ms, plies, reason, outcome). Continuity OUT: one `event: {kind:'play'}` transcript row at end, then `foldIfDue`.
- **Account switch:** `endAllCONNECT4` ends all live sessions (reason `abandoned`) before the scope moves, wired into `accountSessions.ts` after backseat.
- **UI:** `src/renderer/src/components/connect4/Connect4Panel.tsx` + `useConnect4Store` mirror store. Mounts as a right-side panel in ChatScreen alongside chess/Draw!. Board uses `tokens.css` tokens (no literal hex/px).
- **Record:** per-character match metadata (winner, reason, ply count, duration) rides on `CONNECT4_game_ended`; `result.winner === 'player'` means player win, `null` draw.
- **IPC:** `CONNECT4:start` / `get-state` / `move` / `resign` / `rematch` / `end`, plus push `CONNECT4:state` on every change. RendererApi: `CONNECT4Start`/`GetState`/`Move`/`Resign`/`Rematch`/`End`/`onCONNECT4State`.
- **Shared registrations:** `GameId` += `CONNECT4`; `GAME_CATALOG` entry `{id:'CONNECT4', name:'Forza 4', available:true}`; `GAME_PACKS` entry (no pack, `requiredPaths: []`); `BOT_ERROR_ROUTES.CONNECT4 = {}`; `GAME_SURFACES.CONNECT4 = withGame('CONNECT4')`; `summonFlows.CONNECT4` default flow; `PLAN_GAMES.CONNECT4 = 'Forza 4'` (bot/brain/nextStep.js); `WorldState` member `({ game: 'CONNECT4' } & GenericWorldState)`.
- **i18n:** keys in es/it/ja/pt-BR/ru/zh (placeholder English values where not translated). No em dashes in user copy.




