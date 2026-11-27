/**
 * Test 2: skill by character. One character per process plays N seeded games
 * of Fleet Battle and N of Four in a Row against fixed baseline bots, through
 * the REAL services (startBATTLESHIP / placeFleet / playerMove, startCONNECT4 /
 * playerMove), the real board-turn runner and the real Anthropic provider
 * (BYOK branch, claude-haiku-5-5 = the cloud plan's companion model).
 *
 * Fleet Battle: the player side is the fixed fleet seededFleet(seed) (same
 * for every character). To measure the character's shots-to-sink without
 * the game stopping early, the player side fires only at water (cells off
 * the character's fleet) and never fires the last cell of its fleet; the
 * race against the hunt/target baseline is then scored offline: the
 * baseline's shots to sink the character's own fleet vs the character's
 * shots to sink the player's (the player fires first, so ties go to the
 * baseline). No player chat.
 *
 * Four in a Row: baseline = win / block / never hand over a win / window
 * heuristic with center preference, seeded ties. Colors alternate by seed
 * (even seed: character is red and opens). No player chat.
 *
 * Env: MG_CHAR (character name, default Sui), MG_N (games per game type,
 * default 6), MG_SEED0 (default 1), MG_GAMES (bs,c4), MG_EVAL_OUT (output dir).
 */
import { describe, it } from 'vitest';
import type { ChatMessage } from '../../src/shared/ipc';
import {
  initBATTLESHIPService,
  startBATTLESHIP,
  placeFleet,
  playerMove as bsPlayerMove,
  retryAiTurn as bsRetry,
  getBATTLESHIPState,
  endBATTLESHIP,
  __setBattleshipTestHooks,
} from '../../src/main/battleship/battleshipService';
import {
  initCONNECT4Service,
  startCONNECT4,
  playerMove as c4PlayerMove,
  retryAiTurn as c4Retry,
  getCONNECT4State,
  endCONNECT4,
  __setConnect4TestHooks,
} from '../../src/main/connect4/connect4Service';
import { placementCells, type BATTLESHIPPlacement } from '../../src/shared/battleshipIpc';
import {
  Meter,
  appendJsonl,
  characterRow,
  companionProvider,
  installGlobals,
  registerGameCharacter,
  rng,
  waitUntil,
  type CallRecord,
} from './lib/env';
import { baselineShotsToSink, parsePlaceFleet, seededFleet, shotMetrics } from './lib/battleship';
import { baselineMove, baselineRng, checkMoves, minimaxMove } from './lib/connect4';

const CHAR = process.env.MG_CHAR || 'Sui';
const N = Number(process.env.MG_N || 6);
const SEED0 = Number(process.env.MG_SEED0 || 1);
const GAMES = (process.env.MG_GAMES || 'bs,c4').split(',');
const PLAYER = 'Ren';
/** C4 baseline: 'heuristic' (win/block/safe/center) or 'minimaxN' (negamax depth N). */
const C4_BASE = process.env.MG_C4_BASELINE || 'heuristic';
/** Output subdir (so a second baseline does not mix with the first). */
const SUB = process.env.MG_SKILL_SUB || 'skill';
const TURN_WAIT_MS = 6 * 60_000;

function summarizeCalls(calls: CallRecord[]) {
  const byKind: Record<string, { n: number; ms: number[] }> = {};
  for (const c of calls) {
    byKind[c.kind] ??= { n: 0, ms: [] };
    byKind[c.kind].n++;
    byKind[c.kind].ms.push(c.ms);
  }
  return {
    calls: calls.length,
    cost: calls.reduce((a, c) => a + c.cost, 0),
    errors: calls.filter((c) => c.error).map((c) => c.error),
    maxTokensStops: calls.filter((c) => c.stopReason === 'max_tokens').length,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.n, msAvg: Math.round(v.ms.reduce((a, b) => a + b, 0) / v.n) }])),
  };
}

describe(`skill: ${CHAR}`, () => {
  it('plays the seeded games', async () => {
    const gl = installGlobals(PLAYER);
    const row = await characterRow(CHAR);
    const meter = new Meter();
    const provider = await companionProvider(meter);
    const spoken: Array<{ characterId: string; msg: ChatMessage }> = [];
    const pushChatMessage = (characterId: string, msg: ChatMessage) => spoken.push({ characterId, msg });
    initBATTLESHIPService({ pushState: () => {}, pushChatMessage, isSummoned: () => false });
    initCONNECT4Service({ pushState: () => {}, pushChatMessage, isSummoned: () => false });
    __setBattleshipTestHooks({ provider });
    __setConnect4TestHooks({ provider });

    for (let k = 0; k < N; k++) {
      const seed = SEED0 + k;

      // ── Fleet Battle ────────────────────────────────────────────────────
      if (GAMES.includes('bs')) {
        const id = registerGameCharacter(gl, row);
        meter.reset();
        gl.captures.length = 0;
        const playerFleet = seededFleet(seed);
        const t0 = Date.now();
        const turnMs: number[] = [];
        let retryClicks = 0;
        let stuck = false;
        await startBATTLESHIP(id, { playerStarts: true });
        await placeFleet(id, playerFleet);
        // Placement turn (retry like the player's Try again).
        for (;;) {
          const st = await waitUntil(() => {
            const s = getBATTLESHIPState(id)!;
            return s.status === 'active' || s.aiTurnFailed ? s : null;
          }, TURN_WAIT_MS);
          if (!st || st.status === 'active') break;
          if (++retryClicks > 3) { stuck = true; break; }
          await bsRetry(id);
        }
        const placeCall = [...meter.calls].reverse().find((c) => c.tools.some((t) => t.name === 'place_fleet' && parsePlaceFleet(t.input)));
        const aiFleet: BATTLESHIPPlacement[] | null = placeCall
          ? parsePlaceFleet(placeCall.tools.find((t) => t.name === 'place_fleet' && parsePlaceFleet(t.input))!.input)
          : null;
        const aiCells = new Set((aiFleet ?? []).flatMap((p) => placementCells(p)).map((c) => `${c.row},${c.col}`));
        // Player side: water first (seeded order), then ship cells but never all of them.
        const prand = rng(seed * 31 + 5);
        const order: Array<[number, number]> = [];
        for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) order.push([r, c]);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(prand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const water = order.filter(([r, c]) => !aiCells.has(`${r},${c}`));
        const shipCells = order.filter(([r, c]) => aiCells.has(`${r},${c}`)).slice(0, Math.max(0, aiCells.size - 1));
        const playerQueue = [...water, ...shipCells];

        while (!stuck) {
          const s = getBATTLESHIPState(id)!;
          if (s.status === 'ended') break;
          if (s.aiShots >= 100 || playerQueue.length === 0) { stuck = true; break; }
          if (s.turn === 'player' && !s.aiThinking) {
            const [r, c] = playerQueue.shift()!;
            const res = await bsPlayerMove(id, r, c);
            if (!res.ok) continue;
            if (res.state.status === 'ended') break;
            const tt = Date.now();
            const done = await waitUntil(() => {
              const x = getBATTLESHIPState(id)!;
              return x.status === 'ended' || x.aiTurnFailed || (x.turn === 'player' && !x.aiThinking) ? x : null;
            }, TURN_WAIT_MS);
            if (!done) { stuck = true; break; }
            if (done.aiTurnFailed) {
              if (++retryClicks > 3) { stuck = true; break; }
              await bsRetry(id);
              continue;
            }
            turnMs.push(Date.now() - tt);
          } else if (s.aiTurnFailed) {
            if (++retryClicks > 3) { stuck = true; break; }
            await bsRetry(id);
          } else {
            await waitUntil(() => {
              const x = getBATTLESHIPState(id)!;
              return x.status === 'ended' || x.aiTurnFailed || (x.turn === 'player' && !x.aiThinking);
            }, TURN_WAIT_MS);
          }
        }
        await meter.idle(1500, 60_000);
        const fin = getBATTLESHIPState(id)!;
        const ended = gl.captures.find((c) => c.event === 'battleship_game_ended')?.props ?? {};
        if (fin.status !== 'ended') await endBATTLESHIP(id);
        const m = shotMetrics(fin.history, 'ai', playerFleet);
        const baseOnPlayer = baselineShotsToSink(playerFleet, seed);
        const baseOnAi = aiFleet ? baselineShotsToSink(aiFleet, seed) : null;
        const finishedAll = fin.result?.winner === 'ai';
        const lines = spoken.filter((x) => x.characterId === id && x.msg.role === 'companion').map((x) => ({ ts: x.msg.ts, text: x.msg.text }));
        const out = {
          test: 'skill',
          game: 'bs',
          character: CHAR,
          seed,
          finishedAll,
          stuck,
          aiShots: m.shots,
          hits: m.hits,
          hitRate: m.hitRate,
          followUpRate: m.followUpRate,
          openHitShots: m.openHitShots,
          followUps: m.followUps,
          sinkSpans: m.sinkSpans,
          baselineShotsOnPlayerFleet: baseOnPlayer,
          baselineShotsOnAiFleet: baseOnAi,
          raceWin: finishedAll && baseOnAi !== null ? m.shots < baseOnAi : false,
          aiFleet,
          playerFleet,
          illegal: ended.illegal_moves ?? null,
          retries: ended.retries ?? null,
          failedTurns: ended.failed_turns ?? null,
          retryClicks,
          turnMsAvg: turnMs.length ? Math.round(turnMs.reduce((a, b) => a + b, 0) / turnMs.length) : null,
          turnMsP90: turnMs.length ? [...turnMs].sort((a, b) => a - b)[Math.floor(turnMs.length * 0.9)] : null,
          gameMs: Date.now() - t0,
          lines,
          llm: summarizeCalls(meter.calls),
          scratch: meter.calls.filter((c) => c.kind === 'move' && c.text).slice(0, 12).map((c) => c.text.slice(0, 400)),
          history: fin.history,
        };
        appendJsonl(`${SUB}/${CHAR.replace(/\W+/g, '_')}.jsonl`, out);
        appendJsonl('spend.jsonl', { test: 'skill', game: 'bs', character: CHAR, seed, cost: out.llm.cost });
        console.log(`[mg-eval] ${CHAR} bs seed=${seed} shots=${m.shots} hit=${m.hitRate.toFixed(2)} follow=${m.followUpRate.toFixed(2)} base(ai fleet)=${baseOnAi} race=${out.raceWin} illegal=${out.illegal} stuck=${stuck} cost=$${out.llm.cost.toFixed(4)} turn=${out.turnMsAvg}ms`);
      }

      // ── Four in a Row ───────────────────────────────────────────────────
      if (GAMES.includes('c4')) {
        const id = registerGameCharacter(gl, row);
        meter.reset();
        gl.captures.length = 0;
        const aiRed = seed % 2 === 0;
        const playerColor = aiRed ? 'y' : 'r';
        const rand = baselineRng(seed);
        const t0 = Date.now();
        const turnMs: number[] = [];
        let retryClicks = 0;
        let stuck = false;
        await startCONNECT4(id, { playerColor });
        for (;;) {
          const s = getCONNECT4State(id)!;
          if (s.status === 'ended') break;
          if (s.aiTurnFailed) {
            if (++retryClicks > 3) { stuck = true; break; }
            await c4Retry(id);
            continue;
          }
          if (s.turn === s.playerColor && !s.aiThinking) {
            const col = s.moves === 0
              ? 1 + Math.floor(rand() * 5)
              : C4_BASE.startsWith('minimax')
                ? minimaxMove(s.board, playerColor, Number(C4_BASE.slice(7)) || 4, rand)
                : baselineMove(s.board, playerColor, rand);
            const res = await c4PlayerMove(id, col);
            if (!res.ok) throw new Error(`baseline move rejected: ${res.error}`);
            if (res.state.status === 'ended') break;
          }
          const tt = Date.now();
          const done = await waitUntil(() => {
            const x = getCONNECT4State(id)!;
            return x.status === 'ended' || x.aiTurnFailed || (x.turn === x.playerColor && !x.aiThinking) ? x : null;
          }, TURN_WAIT_MS);
          if (!done) { stuck = true; break; }
          if (!done.aiTurnFailed && done.history.length && done.history[done.history.length - 1].color !== playerColor) turnMs.push(Date.now() - tt);
        }
        await meter.idle(1500, 60_000);
        const fin = getCONNECT4State(id)!;
        const ended = gl.captures.find((c) => c.event === 'connect4_game_ended')?.props ?? {};
        if (fin.status !== 'ended') await endCONNECT4(id);
        const aiColor = playerColor === 'r' ? 'y' : 'r';
        const checks = checkMoves(fin.history, aiColor);
        const outcome = !fin.result || fin.status !== 'ended' ? 'unfinished' : fin.result.winner === null ? 'draw' : fin.result.winner === aiColor ? 'win' : 'loss';
        const lines = spoken.filter((x) => x.characterId === id && x.msg.role === 'companion').map((x) => ({ ts: x.msg.ts, text: x.msg.text }));
        const out = {
          test: 'skill',
          game: 'c4',
          character: CHAR,
          seed,
          c4Baseline: C4_BASE,
          aiColor,
          outcome,
          stuck,
          plies: fin.moves,
          aiMoves: checks.length,
          missedWins: checks.filter((c) => c.missedWin).length,
          missedBlocks: checks.filter((c) => c.missedBlock).length,
          gaveWins: checks.filter((c) => c.gaveWin).length,
          illegal: ended.illegal_moves ?? null,
          retries: ended.retries ?? null,
          failedTurns: ended.failed_turns ?? null,
          retryClicks,
          turnMsAvg: turnMs.length ? Math.round(turnMs.reduce((a, b) => a + b, 0) / turnMs.length) : null,
          gameMs: Date.now() - t0,
          lines,
          llm: summarizeCalls(meter.calls),
          scratch: meter.calls.filter((c) => c.kind === 'move' && c.text).slice(0, 12).map((c) => c.text.slice(0, 400)),
          history: fin.history,
          checks,
        };
        appendJsonl(`${SUB}/${CHAR.replace(/\W+/g, '_')}.jsonl`, out);
        appendJsonl('spend.jsonl', { test: 'skill', game: 'c4', character: CHAR, seed, cost: out.llm.cost });
        console.log(`[mg-eval] ${CHAR} c4 seed=${seed} ${aiColor} ${outcome} plies=${fin.moves} missedWin=${out.missedWins} missedBlock=${out.missedBlocks} gave=${out.gaveWins} illegal=${out.illegal} cost=$${out.llm.cost.toFixed(4)} turn=${out.turnMsAvg}ms`);
      }
    }
  });
});
