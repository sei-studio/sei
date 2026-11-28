/**
 * Probe (T567): cheap check of how a character teaches, Haiku only, no
 * learner model. Scripted player moves, real companion turns, a few fixed
 * beginner questions at set points. Every spoken line is recorded with the
 * phase it came in, plus the board state the question was asked on, for a
 * quick read across characters before paying for full teaching games.
 *
 * Fleet Battle: the opener while fleets are placed, a miss, a hit on one of
 * its ships ("what now?"), then sinking its destroyer ("whose ship sank,
 * where next?"). Four in a Row (player red): the opener, three scripted
 * moves along the bottom row where open, then "what should i watch for?".
 *
 * Env: MG_CHARS (comma list, default "Sui,Eris Greyrat,Marv,Lyra"),
 * MG_PROBE_GAMES (bs,c4), MG_PROBE_TAG (label written to every row).
 * Writes <out>/probe/teach.jsonl.
 */
import { describe, it } from 'vitest';
import type { ChatMessage } from '../../src/shared/ipc';
import {
  initBATTLESHIPService, startBATTLESHIP, placeFleet, playerMove as bsMove, getBATTLESHIPState,
  handlePlayerChat as bsChat, endBATTLESHIP, __setBattleshipTestHooks,
} from '../../src/main/battleship/battleshipService';
import {
  initCONNECT4Service, startCONNECT4, playerMove as c4Move, getCONNECT4State,
  handlePlayerChat as c4Chat, endCONNECT4, __setConnect4TestHooks,
} from '../../src/main/connect4/connect4Service';
import { placementCells } from '../../src/shared/battleshipIpc';
import { Meter, appendJsonl, characterRow, companionProvider, installGlobals, registerGameCharacter, waitUntil } from './lib/env';
import { enemyWatersText, fleetLine, parsePlaceFleet, seededFleet } from './lib/battleship';
import { boardView } from './lib/connect4';

const CHARS = (process.env.MG_CHARS || 'Sui,Eris Greyrat,Marv,Lyra').split(',').map((s) => s.trim()).filter(Boolean);
const GAMES = (process.env.MG_PROBE_GAMES || 'bs,c4').split(',');
const TAG = process.env.MG_PROBE_TAG || '';
const OPENER = "hey, i've never played this before. can you teach me as we go?";
const BS_HIT_Q = 'ooh it says hit! what do i do now?';
const BS_SINK_Q = 'wait the screen said something sank. did i sink one of yours or did you sink one of mine? and where should i shoot next';
const C4_Q = 'ok what should i be watching out for right now? and whats a good move for me';

describe('probe: teaching lines across characters', () => {
  it('runs', async () => {
    const gl = installGlobals('Ren');
    const meter = new Meter();
    const inner = await companionProvider(meter);
    // The last chat-reply turn block (the facts the reply was given).
    let lastBlock = '';
    const provider = {
      ...inner,
      call: async (p: Parameters<typeof inner.call>[0]) => {
        const m = p.messages[p.messages.length - 1] as { content: unknown };
        const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (t.includes('They just said')) lastBlock = t.replace(/\\n/g, '\n');
        return inner.call(p);
      },
    };
    const spoken: Array<{ id: string; text: string; phase: string }> = [];
    let phase = '';
    const push = (id: string, m: ChatMessage) => { if (m.role === 'companion') spoken.push({ id, text: m.text, phase }); };
    initBATTLESHIPService({ pushState: () => {}, pushChatMessage: push, isSummoned: () => false });
    initCONNECT4Service({ pushState: () => {}, pushChatMessage: push, isSummoned: () => false });
    __setBattleshipTestHooks({ provider });
    __setConnect4TestHooks({ provider });
    let total = 0;
    for (const name of CHARS) {
      const row = await characterRow(name);
      if (GAMES.includes('bs')) {
        const id = registerGameCharacter(gl, row);
        meter.reset();
        phase = 'open';
        await startBATTLESHIP(id, { playerStarts: true });
        await bsChat({ characterId: id, text: OPENER });
        await meter.idle(1000, 60_000);
        await placeFleet(id, seededFleet(4242));
        await waitUntil(() => getBATTLESHIPState(id)!.status === 'active', 120_000);
        const call = meter.calls.find((c) => c.tools.some((x) => x.name === 'place_fleet' && parsePlaceFleet(x.input)));
        const fleet = parsePlaceFleet(call!.tools.find((x) => x.name === 'place_fleet' && parsePlaceFleet(x.input))!.input)!;
        const occupied = (r: number, c: number) => fleet.some((p) => placementCells(p).some((x) => x.row === r && x.col === c));
        const ready = () => waitUntil(() => { const s = getBATTLESHIPState(id)!; return s.status !== 'active' || (s.turn === 'player' && !s.aiThinking); }, 120_000);
        let water: [number, number] = [0, 0];
        outer: for (let r = 9; r >= 0; r--) for (let c = 9; c >= 0; c--) if (!occupied(r, c)) { water = [r, c]; break outer; }
        const cruiser = placementCells(fleet.find((p) => p.name === 'cruiser')!);
        const destroyer = placementCells(fleet.find((p) => p.name === 'destroyer')!);
        const asked: Record<string, unknown> = {};
        phase = 'moves-1';
        for (const [r, c] of [water, [cruiser[1].row, cruiser[1].col] as [number, number]]) { await ready(); await bsMove(id, r, c); }
        await ready();
        phase = 'q-hit';
        asked.hitBoard = enemyWatersText(getBATTLESHIPState(id)!);
        await bsChat({ characterId: id, text: BS_HIT_Q });
        await meter.idle(1000, 60_000);
        asked.hitBlock = lastBlock;
        phase = 'moves-2';
        for (const x of destroyer) { await ready(); await bsMove(id, x.row, x.col); }
        await ready();
        phase = 'q-sink';
        const st = getBATTLESHIPState(id)!;
        asked.sinkBoard = enemyWatersText(st);
        asked.playerSankOf = st.history.filter((h) => h.by === 'player' && h.sunkShip).map((h) => h.sunkShip);
        asked.aiSankOf = st.history.filter((h) => h.by === 'ai' && h.sunkShip).map((h) => h.sunkShip);
        await bsChat({ characterId: id, text: BS_SINK_Q });
        await meter.idle(1000, 60_000);
        asked.sinkBlock = lastBlock;
        appendJsonl('probe/teach.jsonl', {
          tag: TAG, game: 'bs', character: name, aiFleet: fleetLine(fleet), ...asked,
          lines: spoken.filter((x) => x.id === id).map(({ phase: p, text }) => ({ phase: p, text })),
          cost: meter.cost,
        });
        total += meter.cost;
        appendJsonl('spend.jsonl', { test: 'probe-teach', game: 'bs', character: name, cost: meter.cost });
        await endBATTLESHIP(id);
      }
      if (GAMES.includes('c4')) {
        const id = registerGameCharacter(gl, row);
        meter.reset();
        phase = 'open';
        await startCONNECT4(id, { playerColor: 'r' });
        await c4Chat({ characterId: id, text: OPENER });
        await meter.idle(1000, 60_000);
        const ready = () => waitUntil(() => { const s = getCONNECT4State(id)!; return s.status !== 'active' || (s.turn === 'r' && !s.aiThinking); }, 120_000);
        phase = 'moves';
        for (const want of [3, 2, 4]) {
          await ready();
          const s = getCONNECT4State(id)!;
          if (s.status !== 'active') break;
          const col = s.board[5][want] === null ? want : [3, 2, 4, 1, 5].find((c) => s.board[0][c] === null)!;
          await c4Move(id, col);
        }
        await ready();
        phase = 'q';
        const board = boardView(getCONNECT4State(id)!);
        await c4Chat({ characterId: id, text: C4_Q });
        await meter.idle(1000, 60_000);
        appendJsonl('probe/teach.jsonl', {
          tag: TAG, game: 'c4', character: name, board, block: lastBlock,
          lines: spoken.filter((x) => x.id === id).map(({ phase: p, text }) => ({ phase: p, text })),
          cost: meter.cost,
        });
        total += meter.cost;
        appendJsonl('spend.jsonl', { test: 'probe-teach', game: 'c4', character: name, cost: meter.cost });
        await endCONNECT4(id);
      }
    }
    console.log(`[mg-eval] probe-teach ${TAG} cost=$${total.toFixed(3)}`);
  });
});
