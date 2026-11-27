/**
 * Probe (T565): Fleet Battle chat replies about who sank what. The player
 * sinks the character's destroyer (cells read from its own place_fleet call),
 * the character keeps shooting for real, then the player asks a
 * whose-ship question. Records the facts it was given and what it said, for
 * a quick read. Writes <out>/probe/bs-facts.jsonl. Cheap: Haiku only.
 *
 * Env: MG_TRIALS (default 4), MG_CHAR (default Sui), MG_QUESTION.
 */
import { describe, it } from 'vitest';
import type { ChatMessage } from '../../src/shared/ipc';
import {
  initBATTLESHIPService, startBATTLESHIP, placeFleet, playerMove, getBATTLESHIPState, handlePlayerChat,
  endBATTLESHIP, __setBattleshipTestHooks,
} from '../../src/main/battleship/battleshipService';
import { placementCells } from '../../src/shared/battleshipIpc';
import { Meter, appendJsonl, characterRow, companionProvider, installGlobals, registerGameCharacter, waitUntil } from './lib/env';
import { parsePlaceFleet, seededFleet } from './lib/battleship';

const TRIALS = Number(process.env.MG_TRIALS || 4);
const QUESTION =
  process.env.MG_QUESTION || "wait the screen said something sank. did i sink one of yours or did you sink one of mine? and where should i shoot next";

describe('probe: Fleet Battle whose-ship facts in chat', () => {
  it('runs', async () => {
    const gl = installGlobals('Ren');
    const row = await characterRow(process.env.MG_CHAR || 'Sui');
    const meter = new Meter();
    const inner = await companionProvider(meter);
    let lastBlock = '';
    const provider = {
      ...inner,
      call: async (p: Parameters<typeof inner.call>[0]) => {
        const m = p.messages[p.messages.length - 1] as { content: unknown };
        const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (t.includes('They just said')) lastBlock = t;
        return inner.call(p);
      },
    };
    const spoken: Array<{ id: string; text: string }> = [];
    initBATTLESHIPService({
      pushState: () => {},
      pushChatMessage: (id: string, m: ChatMessage) => { if (m.role === 'companion') spoken.push({ id, text: m.text }); },
      isSummoned: () => false,
    });
    __setBattleshipTestHooks({ provider });
    for (let t = 0; t < TRIALS; t++) {
      const id = registerGameCharacter(gl, row);
      meter.reset();
      await startBATTLESHIP(id, { playerStarts: true });
      await placeFleet(id, seededFleet(100 + t));
      await waitUntil(() => getBATTLESHIPState(id)!.status === 'active', 120_000);
      const call = meter.calls.find((c) => c.tools.some((x) => x.name === 'place_fleet' && parsePlaceFleet(x.input)));
      const fleet = parsePlaceFleet(call!.tools.find((x) => x.name === 'place_fleet' && parsePlaceFleet(x.input))!.input)!;
      const destroyer = placementCells(fleet.find((p) => p.name === 'destroyer')!);
      // Two misses, then the destroyer; the character shoots in between.
      const water: Array<[number, number]> = [];
      for (let r = 0; r < 10 && water.length < 2; r++) {
        for (let c = 0; c < 10 && water.length < 2; c++) {
          if (!fleet.some((p) => placementCells(p).some((x) => x.row === r && x.col === c))) water.push([r, c]);
        }
      }
      for (const [r, c] of [...water, ...destroyer.map((x) => [x.row, x.col] as [number, number])]) {
        await waitUntil(() => { const s = getBATTLESHIPState(id)!; return s.turn === 'player' && !s.aiThinking; }, 120_000);
        await playerMove(id, r, c);
      }
      await waitUntil(() => { const s = getBATTLESHIPState(id)!; return s.turn === 'player' && !s.aiThinking; }, 120_000);
      const before = spoken.length;
      await handlePlayerChat({ characterId: id, text: QUESTION });
      await meter.idle(1000, 60_000);
      const st = getBATTLESHIPState(id)!;
      appendJsonl('probe/bs-facts.jsonl', {
        trial: t,
        theirSunk: st.playerGrid.ships.filter((s) => s.sunk).map((s) => s.name),
        aiShots: st.history.filter((h) => h.by === 'ai').map((h) => ({ row: h.row, col: h.col, hit: h.hit, sunk: h.sunkShip })),
        facts: (lastBlock.replace(/\\n/g, '\n').match(/Facts the app checked[\s\S]*?Next shot:[^\n]*/) ?? [''])[0],
        reply: spoken.slice(before).filter((x) => x.id === id).map((x) => x.text),
        cost: meter.cost,
      });
      appendJsonl('spend.jsonl', { test: 'probe-bs-facts', trial: t, cost: meter.cost });
      await endBATTLESHIP(id);
    }
  });
});
