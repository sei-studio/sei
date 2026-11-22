# Battleship minigame (Battleship)

An in-app, untimed Battleship game (two 10x10 grids, 5 ships each: carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2, placed randomly at start) against the character, launched from the "Play together" tiles. **Mutually exclusive with a Minecraft summon** per character (enforced by gameLaunch + isSummoned gate).

- **No engine, no model download.** The character picks its shot via the LLM calling a `fire(row, col)` tool (row/col 0-9). If the model does not produce a legal cell, the first free cell is fired so the game never stalls (`BATTLESHIP_MAX_HOPS=5`, `TURN_TIMEOUT_MS=90000`).
- **Service:** `src/main/battleship/battleshipService.ts` owns authoritative state (one session per character, `sessions` Map), shot validation, ship placement, all-ships-sunk detection, and the `fire`/`remember` tool runner. Protocol contract: `src/shared/battleshipIpc.ts`.
- **Analytics / instrumentation:** `BATTLESHIP_game_started` (character_id, player_starts) and `BATTLESHIP_game_ended` (duration_ms, shots, reason, outcome). Continuity OUT: one `event: {kind:'play'}` transcript row at end, then `foldIfDue`.
- **Account switch:** `endAllBATTLESHIP` ends all live sessions (reason `abandoned`) before the scope moves, wired into `accountSessions.ts` after CONNECT4.
- **UI:** `src/renderer/src/components/battleship/BattleshipPanel.tsx` + `useBattleshipStore` mirror store. Mounts as a right-side panel in ChatScreen alongside chess/Draw!/CONNECT4. Two grids (player ships visible, AI hits/misses only) use `tokens.css` tokens (no literal hex/px).
- **Record:** per-character match metadata (winner, reason, shot count, duration) rides on `BATTLESHIP_game_ended`; `result.winner === 'player'` means player win, `null` draw.
- **IPC:** `BATTLESHIP:start` / `get-state` / `move` / `resign` / `rematch` / `end`, plus push `BATTLESHIP:state` on every change. RendererApi: `BATTLESHIPStart`/`GetState`/`Move`/`Resign`/`Rematch`/`End`/`onBATTLESHIPState`.
- **Shared registrations:** `GameId` += `BATTLESHIP`; `GAME_CATALOG` entry `{id:'BATTLESHIP', name:'Battleship', available:true}`; `GAME_PACKS` entry (no pack, `requiredPaths: []`); `BOT_ERROR_ROUTES.BATTLESHIP = {}`; `GAME_SURFACES.BATTLESHIP = withGame('BATTLESHIP')`; `summonFlows.BATTLESHIP` default flow; `PLAN_GAMES.BATTLESHIP = 'Battleship'` (bot/brain/nextStep.js); `WorldState` member `({ game: 'BATTLESHIP' } & GenericWorldState)`.
- **i18n:** keys in es/it/ja/pt-BR/ru/zh (placeholder English values where not translated). No em dashes in user copy.




