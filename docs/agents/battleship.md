# Fleet Battle minigame (internal id BATTLESHIP)

An in-app, untimed Fleet Battle game (two 10x10 boards, rows A-J and columns 1-10, five ships each: carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2) against the character, opened from the "Play together" picker. **Mutually exclusive with a Minecraft summon** per character (gameLaunch cross-launch gate + `deps.isSummoned`). User-facing and model-facing name: **Fleet Battle** (never a trademarked name; internal ids and file names keep `BATTLESHIP`; "battleship" as a ship type is fine).

## The character plays for real (261127)

- **Placement:** the game opens in `preparing`. The player places their five ships (pick a ship, Rotate, tap a cell; Random rolls a fleet) and confirms (`BATTLESHIPPlaceFleet`). At the same time the character places ITS fleet with one `place_fleet({ships:[{ship, start:"C2", direction:"right"|"down"}]})` call, validated by `fleetProblem` (all five once, on the board, no overlap); a bad fleet goes back as a tool error and the turn is retried like a move. `aiFleet` is `placing` / `ready` / `failed`. The battle opens when both fleets are ready (`maybeBeginBattle`).
- **Every shot is the character's own `fire({cell:"B7"})` call**, named the way the board labels cells (`parseBattleshipCell` also takes "b 7" and "7B"). A cell already fired at (miss, hit OR sunk) is rejected back to the model. There is no fallback shot or placement anywhere.
- **Turn runner, retries, failed state, budgets, turn tokens, turn ownership, table talk, chat:** same as Four in a Row (see `connect4.md`, `src/main/minigames/boardTurn.ts`). Talk is the `say` field of `fire()` / `place_fleet()`; plain text on the character's turn is private. `aiFleet` becomes `ready` (and the battle may open) and the turn passes only after the runner returns. Surface `battleship`; Try again = `BATTLESHIP:retry` and covers a failed placement too.
- **Game-over turn:** `gameOverBlock` states the result first with the player named and which side the character speaks from, and shows no boards (Haiku flipped the winner with the boards shown or with a bare "YOU WON").
- **The tool_result bug this replaces (261127, proven).** The old turn loop answered the model's tool calls with a PLAIN TEXT user message. Any turn that needed a second hop (the model re-fired a cell it had already shot, or called remember first) then sent an assistant `tool_use` with no `tool_result` after it, which Anthropic rejects with `400 messages.N: tool_use ids were found without tool_result blocks immediately after` (OpenAI-compatible APIs reject the same shape). Every such turn failed and the engine fallback shot instead. Measured against the old code with Haiku 5.5: 5 of 13 AI turns in one game. `runBoardTurn` sends `tool_result` blocks; `battleshipService.test.ts` pins the shape on a multi-hop turn.
- **The character's shot record is `playerGrid`, never `aiVisibleGrid` (261125).** `aiVisibleGrid` is the player's view of the character's board. The prompt shows the character the player's board as "." / "o" miss / "X" hit / "#" sunk (ships hidden) and its own board with its ships.

## Rules and state

- Shots alternate; the first side to sink all five opposing ships wins. Resign is allowed during placement too (the character wins). Rematch alternates who fires first (`playerStarts`), from the service (`rematch`), so the panel's Rematch button calls it directly.
- `history` records both sides' shots with `by: 'player' | 'ai'`; `playerShots` / `aiShots` count each side, `shotsFired` is the total.
- On `ended`, `aiVisibleGrid.ships` carries the character's fleet so the panel can reveal it (empty before that).
- **Service:** `src/main/battleship/battleshipService.ts`. Contract + pure helpers (`placementCells`, `placementFits`, `fleetCells`, `fleetProblem`, `parseBattleshipCell`, `battleshipCellName`, `randomFleetPlacement` for the player's Random button only): `src/shared/battleshipIpc.ts`. In memory only, like chess.
- **IPC:** `battleship:start` / `get-state` / `place-fleet` / `move` / `resign` / `rematch` / `retry` / `end`, push `battleship:state`. RendererApi `BATTLESHIPStart` / `GetState` / `PlaceFleet` / `Move` / `Resign` / `Rematch` / `Retry` / `End` / `onBATTLESHIPState`.
- **Teardown:** as Four in a Row (`endAllBATTLESHIP`, `shutdownBATTLESHIP`, WorldLink probe). Not in `GAME_IDS`.

## Analytics (shape only)

- `battleship_game_started {character_id, player_starts, rematch}`
- `battleship_fleet_placed {character_id, by: 'player'|'ai', random?, ms_since_start}`
- `battleship_first_move {character_id, by, ms_since_start}`
- `battleship_turn_failed {character_id, turn_kind: 'place'|'shot', reason, attempts, error_class, shot_number}`, plus `surface_error {surface:'battleship', error_class:'move_turn_<class>' | 'place_turn_<class>'}` per failed attempt
- `battleship_turn_retry {character_id, reason, turn_kind}`
- `battleship_game_ended {character_id, duration_ms, shots, player_moves, llm_moves (its placement + its shots), engine_moves (always 0), retries, illegal_moves, failed_turns, retry_clicks, chat_replies, spoke, ended_in, reason, outcome}`
- Continuity OUT: one `{kind:'play', game:'Fleet Battle'}` row, then `foldIfDue(id, persona.expanded)`.
