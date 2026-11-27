/**
 * Repro: the player types while the character is making its opening move
 * (character = red, moves first). Records what the chat-reply turn was sent
 * (the tail of the thread) and what it said. Writes <out>/repro/chat-during-move.jsonl.
 */
import { describe, it } from 'vitest';
import type { ChatMessage } from '../../src/shared/ipc';
import {
  initCONNECT4Service, startCONNECT4, getCONNECT4State, handlePlayerChat, endCONNECT4, __setConnect4TestHooks,
} from '../../src/main/connect4/connect4Service';
import { Meter, appendJsonl, characterRow, companionProvider, installGlobals, registerGameCharacter, waitUntil } from './lib/env';

const TRIALS = Number(process.env.MG_TRIALS || 3);
const DELAY = Number(process.env.MG_CHAT_DELAY_MS || 300);

describe('repro: chat during the opening move', () => {
  it('runs', async () => {
    const gl = installGlobals('Ren');
    const row = await characterRow(process.env.MG_CHAR || 'Sui');
    const meter = new Meter();
    const inner = await companionProvider(meter);
    const sent: Array<{ kind: string; tail: unknown }> = [];
    const provider = {
      ...inner,
      call: async (p: Parameters<typeof inner.call>[0]) => {
        const msgs = (p as { messages: Array<{ role: string; content: unknown }> }).messages;
        sent.push({ kind: 'call', tail: msgs.slice(-4) });
        return inner.call(p);
      },
    };
    const spoken: Array<{ id: string; text: string }> = [];
    initCONNECT4Service({ pushState: () => {}, pushChatMessage: (id: string, m: ChatMessage) => { if (m.role === 'companion') spoken.push({ id, text: m.text }); }, isSummoned: () => false });
    __setConnect4TestHooks({ provider });
    for (let t = 0; t < TRIALS; t++) {
      const id = registerGameCharacter(gl, row);
      sent.length = 0;
      meter.reset();
      await startCONNECT4(id, { playerColor: 'y' });
      await new Promise((r) => setTimeout(r, DELAY));
      const wasThinking = getCONNECT4State(id)!.aiThinking;
      await handlePlayerChat({ characterId: id, text: "hey, i've never played this before. can you teach me as we go?" });
      await meter.idle(1500, 60_000);
      await waitUntil(() => !getCONNECT4State(id)!.aiThinking, 60_000);
      appendJsonl('repro/chat-during-move.jsonl', {
        trial: t,
        delayMs: DELAY,
        aiThinkingWhenChatSent: wasThinking,
        calls: meter.calls.map((c, i) => ({ kind: c.kind, text: c.text, tools: c.tools, sentTail: sent[i]?.tail })),
        spoken: spoken.filter((x) => x.id === id).map((x) => x.text),
      });
      await endCONNECT4(id);
    }
  });
});
