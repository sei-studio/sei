/**
 * SeiLink room-edit reaction probe (261105, T335): do her reaction lines read
 * naturally in character and actually name the change?
 *
 * Builds the turn the way chatService.sendDesktopLineTurn does for kind
 * 'react': buildSystemBlocks with the room line, the chat tools with look(),
 * the transcript cached, then roomReactionNote (the change list from the real
 * diff, shared/seilinkRoomDiff.ts, over the bundled cozy pack) after the
 * breakpoint, max 120 tokens. One call per scenario, no tool loop (as the app).
 *
 * Characters: --chars a.json,b.json (a cloud character row, or a list of one,
 * with persona_expanded and name); default the synthetic Sui of call-fixture.
 * Key: ANTHROPIC_API_KEY, else ~/.sei-dev/anthropic-test-key; never printed.
 * Usage: npx tsx scripts/seilink-react-probe.ts [--chars a.json,b.json]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendUncachedTail, buildSystemBlocks, chatSurfaceTools, markLastMessageCached } from '../src/main/chat/chatPrompts';
import { toMessages } from '../src/main/chat/transcript';
import { webToolsFor } from '../src/bot/web/webTools.js';
import type { ChatMessage } from '../src/shared/ipc';
import { roomPromptLine, type RoomContext } from '../src/main/seilink/roomContext';
import { roomReactionNote } from '../src/main/seilink/roomChangeNote';
import { roomChanges } from '../src/shared/seilinkRoomDiff';
import { defaultRoomState, type RoomPresetManifest, type RoomState } from '../src/shared/seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from '../src/shared/seilinkValidate';
import { MEMORY, PERSONA_EXPANDED, STOP } from './call-fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const MODEL = 'claude-haiku-5-5';

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

let spend = 0;
const bill = (u: Anthropic.Messages.Usage): void => {
  spend += (u.input_tokens * 1 + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1 + u.output_tokens * 5) / 1e6;
};

function pack(id: string): RoomPresetManifest {
  const m = parseRoomManifest(JSON.parse(readFileSync(join(HERE, '..', 'resources', 'seilink-packs', id, 'manifest.json'), 'utf8')));
  if (!m) throw new Error(`bad manifest ${id}`);
  return m;
}
const cozy = pack('cozy');
const forest = pack('forest');

function room(edit: (s: RoomState) => void = () => {}): RoomState {
  const s = defaultRoomState('cozy');
  s.items = [
    { id: 'cushion', x: 1500, y: 1300 },
    { id: 'monstera', x: 600, y: 1320 },
  ];
  edit(s);
  return sanitizeRoomState(cozy, JSON.parse(JSON.stringify(s)));
}

const SCENARIOS: Array<{ name: string; after: () => { manifest: RoomPresetManifest; state: RoomState } }> = [
  { name: 'move plant', after: () => ({ manifest: cozy, state: room((s) => void (s.items[1].x = 250)) }) },
  { name: 'pink curtains', after: () => ({ manifest: cozy, state: room((s) => void (s.slots.curtains = { id: 'linen_curtains', tint: '#e070a0' })) }) },
  {
    name: 'striped bed, no rug',
    after: () => ({ manifest: cozy, state: room((s) => ((s.slots.bed = { id: 'wooden_bed', pattern: 'wide_stripe' }), (s.slots.rug = { id: null }))) }),
  },
  {
    name: 'books + succulent + cushion moved',
    after: () => ({
      manifest: cozy,
      state: room((s) => {
        s.items.push({ id: 'books', x: 1200, y: 1300 }, { id: 'succulent', x: 1000, y: 1310 });
        s.items[0].x = 2100;
      }),
    }),
  },
  { name: 'forest preset', after: () => ({ manifest: forest, state: sanitizeRoomState(forest, defaultRoomState('forest')) }) },
];

interface Char {
  name: string;
  persona: string;
  punctuation: string;
}

function loadChar(file: string): Char {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const c = Array.isArray(raw) ? raw[0] : raw;
  return { name: c.name, persona: c.persona_expanded, punctuation: c.metadata?.punctuation ?? 'casual' };
}

async function run(char: Char): Promise<void> {
  const before = { manifest: cozy, state: room() };
  console.log(`\n=== ${char.name}`);
  for (const sc of SCENARIOS) {
    const after = sc.after();
    const ctx: RoomContext = { manifest: after.manifest, state: after.state, packDir: '/probe' };
    const changes = roomChanges(before.manifest, before.state, after.manifest, after.state);
    const system = buildSystemBlocks({
      persona: { source: 'x', expanded: char.persona } as never,
      name: char.name,
      preferredName: 'Ren',
      proactiveness: 1,
      punctuation: char.punctuation,
      memory: MEMORY,
      summary: '',
      openWorldDetected: false,
      inGame: false,
      voiceCall: false,
      language: 'en',
      memoryGuide: true,
      searchGuide: true,
      clockInTail: false,
      roomLine: roomPromptLine(ctx, { includeTime: true }),
    } as never);
    const history: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'ok gonna do some work now', ts: Date.now() - 3_600_000 } as ChatMessage,
      { id: 'c1', role: 'companion', text: 'good luck!! ping me if you get bored', ts: Date.now() - 3_590_000 } as ChatMessage,
    ];
    const messages = toMessages(history) as Anthropic.Messages.MessageParam[];
    markLastMessageCached(messages as never);
    const note = roomReactionNote(changes);
    appendUncachedTail(messages as never, note);
    const tools = chatSurfaceTools(false, webToolsFor({ serverWebSearch: true }) as unknown[], true) as Anthropic.Messages.Tool[];
    const t0 = Date.now();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 120,
      system: system as never,
      tools,
      stop_sequences: STOP,
      messages,
      thinking: { type: 'disabled' },
    } as never);
    bill(res.usage);
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text.trim())
      .join(' ');
    const tools2 = res.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.Messages.ToolUseBlock).name);
    console.log(`[${sc.name}] (${Date.now() - t0} ms${tools2.length ? `, tools: ${tools2.join(',')}` : ''})\n   changes: ${note.match(/What they changed: (.*?)\. Say/)?.[1]}\n   line: ${text}`);
  }
}

async function main(): Promise<void> {
  const files = opt('--chars', '').split(',').filter(Boolean);
  const chars: Char[] = files.length ? files.map(loadChar) : [{ name: 'Sui', persona: PERSONA_EXPANDED, punctuation: 'casual' }];
  for (const c of chars) await run(c);
  console.log(`\nspend ~$${spend.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
