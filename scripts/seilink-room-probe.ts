/**
 * SeiLink room probe (261104): does the companion know where she is, does she
 * call look() when asked about her room, and does she leave the room alone
 * when nobody asks?
 *
 * Builds each turn the way chatService does for typed chat and for a voice
 * call (buildSystemBlocks with the room line, chatSurfaceTools with look(),
 * the call clock in the uncached tail), against the fixture room pack in
 * src/main/seilink/__fixtures__/room-pack (or --room <room.json>). look() is
 * answered by the real lookAtRoom (sharp composite + list), the picture
 * inside the tool_result as chatService sends it to Anthropic (--sibling: the
 * other providers' shape, beside it). Text rows only carry across turns, as in the app.
 *
 * Key: ANTHROPIC_API_KEY, else ~/.sei-dev/anthropic-test-key; never printed.
 * Usage: npx tsx scripts/seilink-room-probe.ts [--reps 2] [--surfaces chat,call] [--room file] [--sibling] [--pinned]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendUncachedTail, buildSystemBlocks, chatSurfaceTools, clockTailNote, markLastMessageCached } from '../src/main/chat/chatPrompts';
import { toMessages } from '../src/main/chat/transcript';
import { webToolsFor } from '../src/bot/web/webTools.js';
import type { ChatMessage } from '../src/shared/ipc';
import { devRoomSource, lookAtRoom, lookResultContent, lookToolResult, roomPromptLine, type RoomContext } from '../src/main/seilink/roomContext';
import { MEMORY, PERSONA_EXPANDED, STOP } from './call-fixture';

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const REPS = Number(opt('--reps', '2'));
const SURFACES = opt('--surfaces', 'chat,call').split(',') as Array<'chat' | 'call'>;
const ROOM = opt('--room', join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'seilink', '__fixtures__', 'room-pack', 'room.json'));
const MODEL = 'claude-haiku-5-5';
const SIBLING = argv.includes('--sibling');

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

// Dollars per token, Haiku-class list prices (in 1, cache write 1.25, cache read 0.1, out 5 per M).
let spend = 0;
const bill = (u: Anthropic.Messages.Usage): void => {
  spend +=
    (u.input_tokens * 1 + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1 + u.output_tokens * 5) / 1e6;
};

const TURNS: Array<{ text: string; kind: 'control' | 'where' | 'look' }> = [
  { text: 'hey what are you up to', kind: 'control' },
  { text: 'where are you right now?', kind: 'where' },
  { text: "what's in your room?", kind: 'look' },
  { text: 'lol nice. did you eat anything today', kind: 'control' },
  { text: 'i have a math test tomorrow, kinda stressed', kind: 'control' },
];

async function runSession(surface: 'chat' | 'call', room: RoomContext, rep: number): Promise<void> {
  const voice = surface === 'call';
  const tools = chatSurfaceTools(voice, webToolsFor({ serverWebSearch: true }) as unknown[], true) as Anthropic.Messages.Tool[];
  const roomLine = roomPromptLine(room, { includeTime: !voice });
  const history: ChatMessage[] = [];
  console.log(`\n=== ${surface} rep ${rep + 1}  room line: ${JSON.stringify(roomLine)}`);
  for (const turn of TURNS) {
    history.push({ id: `u${history.length}`, role: 'user', text: turn.text, ts: Date.now(), ...(voice ? { voice: true } : {}) } as ChatMessage);
    const system = buildSystemBlocks({
      persona: { source: 'x', expanded: PERSONA_EXPANDED } as never,
      name: 'Sui',
      preferredName: 'Ren',
      proactiveness: 1,
      punctuation: 'casual',
      memory: MEMORY,
      summary: '',
      openWorldDetected: false,
      inGame: false,
      voiceCall: voice,
      language: 'en',
      memoryGuide: true,
      searchGuide: true,
      clockInTail: voice,
      roomLine,
    } as never);
    const messages = toMessages(history) as Anthropic.Messages.MessageParam[];
    markLastMessageCached(messages as never);
    if (voice) appendUncachedTail(messages as never, clockTailNote());
    const said: string[] = [];
    const calls: string[] = [];
    for (let hop = 0; hop < 3; hop++) {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: system as never,
        tools,
        stop_sequences: STOP,
        messages,
        thinking: { type: 'disabled' },
      } as never);
      bill(res.usage);
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) said.push(b.text.trim());
      const uses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) break;
      messages.push({ role: 'assistant', content: res.content as never });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      const images = [];
      for (const u of uses) {
        calls.push(u.name);
        if (u.name === 'look') {
          const look = await lookAtRoom(room, { vision: 'yes' });
          // As chatService does for an Anthropic backend; --sibling = the other providers' shape.
          const r = lookToolResult(u.id, look, { nested: !SIBLING });
          results.push(r.result);
          if (r.sibling) images.push(r.sibling);
        } else if (u.name === 'remember') {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Saved to your memory. Continue your reply; do not mention saving it.' });
        } else {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `${u.name} is not available right now.` });
        }
      }
      messages.push({ role: 'user', content: lookResultContent(results, images) as never });
      if (said.length && uses.every((u) => u.name === 'remember')) break;
    }
    const reply = said.join(' / ');
    console.log(`[${turn.kind}] ${turn.text}\n   tools: ${calls.join(', ') || '-'}\n   ${reply}`);
    for (const line of said) history.push({ id: `c${history.length}`, role: 'companion', text: line, ts: Date.now(), ...(voice ? { voice: true } : {}) } as ChatMessage);
  }
}

async function main(): Promise<void> {
  const room = (await devRoomSource(ROOM)!.getRoom('probe')) as RoomContext;
  // The common case: the room follows the clock (the fixture pins night).
  if (!argv.includes('--pinned')) room.state.time = 'auto';
  for (const surface of SURFACES) for (let r = 0; r < REPS; r++) await runSession(surface, room, r);
  console.log(`\nspend ~$${spend.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
