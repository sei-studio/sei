/**
 * SeiLink decorating-together probe (261105, T336): the REAL chat turns
 * (chatService: prompt assembly, tool list, hop loop, decorate, the call
 * picture, the transcript) against a real model, with the editor's side
 * played by this script (it applies her ops and syncs the room back, as
 * RoomTogether does).
 *
 * Sessions per character:
 *  1. Off a call: the player edits, a live line; more edits, a second live line
 *     (only the new changes); a talk-box line with nothing changed.
 *  2. "make it cozier": she decorates (apply), the script applies her ops; the
 *     player undoes them and asks about it.
 *  3. On a call: a change then a line (picture sent), a line with no change
 *     (no picture), a change within 20 s (rate limited), after 20 s (sent).
 *
 * Only ./sdk is swapped (a real Anthropic client on the dev key), plus the
 * character store (a card from --chars) and analytics (off). Spend and token
 * use are printed; transcripts go to $PROBE_OUT (default ./together-probe).
 *
 *   PROBE_CHARS=/path/sui.json,/path/lyra.json \
 *     npx vitest run --config scripts/seilink-together-probe.config.mts
 *
 * Key: ANTHROPIC_API_KEY, else ~/.sei-dev/anthropic-test-key; never printed.
 */
import { describe, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const { usage, requests } = vi.hoisted(() => ({
  usage: [] as Array<{ label: string; input: number; cacheWrite: number; cacheRead: number; output: number }>,
  requests: [] as Array<{ tools: string[]; tail: string; picture: boolean }>,
}));
const state = vi.hoisted(() => ({ label: '', character: null as null | Record<string, unknown> }));

vi.mock('../src/main/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/analytics')>()),
  capture: vi.fn(),
}));
vi.mock('../src/main/chat/sdk', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { readFileSync: read } = await import('node:fs');
  const { homedir: home } = await import('node:os');
  const { join } = await import('node:path');
  const apiKey = process.env.ANTHROPIC_API_KEY || read(join(home(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
  const real = new Anthropic({ apiKey, maxRetries: 4 });
  const note = (params: { tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> }): void => {
    const last = params.messages[params.messages.length - 1];
    const blocks = Array.isArray(last.content) ? (last.content as Array<{ type: string; text?: string }>) : [{ type: 'text', text: String(last.content) }];
    const picture = params.messages.some(
      (m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Array<{ type: string; id?: string }>).some((b) => b.type === 'tool_use' && String(b.id).startsWith('toolu_room_')),
    );
    requests.push({ tools: (params.tools ?? []).map((t) => t.name), tail: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' | '), picture });
  };
  const bill = (u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): void => {
    usage.push({ label: state.label, input: u.input_tokens, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens });
  };
  const client = {
    messages: {
      create: async (params: never, opts?: never) => {
        note(params);
        const res = await real.messages.create({ ...(params as object), thinking: { type: 'disabled' } } as never, opts);
        bill((res as { usage: never }).usage);
        return res;
      },
      stream: (params: never, opts?: never) => {
        note(params);
        const s = real.messages.stream({ ...(params as object), thinking: { type: 'disabled' } } as never, opts);
        void s.finalMessage().then((m) => bill(m.usage as never), () => {});
        return s;
      },
    },
  };
  return { CHAT_TIMEOUT_MS: 60_000, buildChatSdk: vi.fn(async () => ({ client, model: 'claude-haiku-5-5' })) };
});
vi.mock('../src/main/characterStore', () => ({
  getCharacter: vi.fn(async () => structuredClone(state.character)),
  patchCharacter: vi.fn(async (_id: string, fn: (c: unknown) => unknown) => fn(structuredClone(state.character))),
}));
vi.mock('../src/main/configStore', () => ({
  loadConfig: vi.fn(async () => ({ preferred_name: 'Ren' })),
}));
vi.mock('../src/main/llm/webSearchSettings', () => ({
  resolveWebSearchSettings: () => ({ provider: 'auto', api_key: '' }),
  getChatWebSession: () => ({ lastProvider: 'fake', beginTurn() {}, async runTool() { return { content: 'nothing found', is_error: false }; } }),
}));

import { _setUserDataOverride } from '../src/main/paths';
import type { ChatDeps } from '../src/main/chat/chatService';
import { readRecent, sendChatMessage, sendDesktopLineTurn } from '../src/main/chat/chatService';
import { setCallActive } from '../src/main/voice/callState';
import { devRoomSource, setRoomSource, type RoomContext } from '../src/main/seilink/roomContext';
import { __resetTogetherForTest, closeTogether, liveLineNote, markSeen, openTogether, setTogetherSink, syncTogether, togetherByToken, unseenChanges } from '../src/main/seilink/editorTogether';
import { applyRoomOps, type RoomEditOp } from '../src/shared/seilinkDecorate';
import type { RoomState } from '../src/shared/seilinkRoom';
import type { SeilinkEditorEvent } from '../src/shared/seilinkTogether';

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.PROBE_OUT ?? 'together-probe');
const CHAR = '77777777-7777-4777-8777-777777777777';
const TOKEN = 'tok_probe';
const PRICE = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }; // $ per M tokens, Haiku
const deps = (): ChatDeps => ({ getLanState: () => ({ kind: 'closed' }), summon: vi.fn(async () => undefined), leaveGame: vi.fn() });

let log: string[] = [];
const say = (s: string): void => {
  log.push(s);
  console.log(s);
};

function loadCard(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const c = Array.isArray(raw) ? raw[0] : raw;
  return {
    id: CHAR,
    name: c.name,
    persona: { source: c.persona_source ?? '', expanded: c.persona_expanded },
    metadata: { punctuation: c.metadata?.punctuation ?? 'casual', proactiveness: c.metadata?.proactiveness ?? 1 },
  };
}

function cost(rows: typeof usage): number {
  return rows.reduce((a, u) => a + (u.input * PRICE.input + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead + u.output * PRICE.output) / 1e6, 0);
}

describe('decorating together, live', () => {
  const files = (process.env.PROBE_CHARS ?? '').split(',').filter(Boolean);
  for (const file of files) {
    it(`sessions for ${path.basename(file)}`, { timeout: 300_000 }, async () => {
      state.character = loadCard(file);
      const name = String(state.character.name);
      log = [];
      usage.length = 0;
      requests.length = 0;
      const dir = await mkdtemp(path.join(tmpdir(), 'sei-together-probe-'));
      _setUserDataOverride(dir);
      // Her saved room: the real cozy pack, a few things placed.
      const roomDir = path.join(dir, 'room');
      await mkdir(roomDir, { recursive: true });
      const saved: RoomState = {
        version: 1,
        preset: 'cozy',
        time: 'dusk',
        slots: {},
        items: [
          { id: 'cushion', x: 1500, y: 1300 },
          { id: 'books', x: 300, y: 690 },
        ],
        avatar: { kind: 'sei' },
      } as unknown as RoomState;
      await writeFile(path.join(roomDir, 'state.json'), JSON.stringify(saved));
      await writeFile(path.join(roomDir, 'room.json'), JSON.stringify({ packDir: path.join(REPO, 'resources', 'seilink-packs', 'cozy'), state: 'state.json', characters: '*' }));
      setRoomSource(devRoomSource(path.join(roomDir, 'room.json')));
      const savedRoom = (): RoomContext => devRoomSource(path.join(roomDir, 'room.json'))!.getRoom(CHAR) as RoomContext;
      __resetTogetherForTest();
      const events: SeilinkEditorEvent[] = [];
      let editorRoom: RoomContext = savedRoom();
      // The editor's side: apply her ops as one step and sync the room back.
      setTogetherSink((e) => {
        events.push(e);
        if (e.kind === 'edits' && e.mode === 'apply') {
          editorRoom = { ...editorRoom, state: applyRoomOps(editorRoom.manifest, editorRoom.state, e.ops as RoomEditOp[]).state };
          syncTogether(TOKEN, editorRoom, Date.now());
        }
      });
      const edit = (label: string, fn: (s: RoomState) => RoomState): void => {
        editorRoom = { ...editorRoom, state: fn(structuredClone(editorRoom.state)) };
        syncTogether(TOKEN, editorRoom, Date.now());
        say(`  [player edits] ${label}`);
      };
      const mark = (): number => usage.length;
      const turnLine = async (label: string, text: string, voiceCall = false): Promise<void> => {
        state.label = label;
        const u0 = mark();
        const r0 = requests.length;
        const e0 = events.length;
        const res = await sendChatMessage({ characterId: CHAR, text, ...(voiceCall ? { voiceCall: true } : {}) }, deps());
        const reply = res.replies.map((m) => m.text).join(' / ');
        const mine = events.slice(e0).filter((e) => e.kind === 'edits');
        const hops = requests.slice(r0);
        say(`  ${voiceCall ? '[call] ' : ''}Ren: ${text}`);
        for (const e of mine) if (e.kind === 'edits') say(`    (decorate ${e.mode}: ${e.changes.map((c) => c.text).join('; ')})`);
        say(`  ${name}: ${reply}`);
        say(`    hops ${hops.length}, picture ${hops.some((h) => h.picture) ? 'yes' : 'no'}, decorate offered ${hops[0]?.tools.includes('decorate') ? 'yes' : 'no'}, tokens ${JSON.stringify(usage.slice(u0).map(({ label: _l, ...x }) => x))}`);
      };

      say(`=== ${name}`);
      // ── Session 1: off a call, she watches ──
      say('-- session 1: edits, then a live line');
      openTogether(TOKEN, CHAR, savedRoom(), { now: Date.now(), onCall: false });
      const curtains = editorRoom.manifest.components.find((c) => c.slot === 'curtains')!;
      edit('curtains to navy', (s) => ({ ...s, slots: { ...s.slots, curtains: { id: curtains.id, tint: '#2c3a5e' } } }));
      edit('cushion to the left', (s) => ({ ...s, items: s.items.map((i) => (i.id === 'cushion' ? { ...i, x: 600 } : i)) }));
      const live = async (label: string): Promise<void> => {
        const s = togetherByToken(TOKEN)!;
        const changes = unseenChanges(s);
        state.label = label;
        const u0 = mark();
        const r0 = requests.length;
        const line = await sendDesktopLineTurn(CHAR, 'react', undefined, liveLineNote(changes));
        markSeen(s, Date.now());
        say(`  [live line, ${changes.length} change(s): ${changes.map((c) => c.text).join('; ')}]`);
        say(`  ${name}: ${line?.text ?? '(silence)'}`);
        say(`    note: ${requests[r0]?.tail.slice(0, 400)}`);
        say(`    tokens ${JSON.stringify(usage.slice(u0).map(({ label: _l, ...x }) => x))}`);
      };
      await live('live line 1');
      edit('walls to sage', (s) => {
        const walls = editorRoom.manifest.components.find((c) => c.slot === 'shell')!;
        return { ...s, slots: { ...s.slots, shell: { id: walls.id, tint: '#9caf88' } } };
      });
      await live('live line 2');
      await turnLine('talk, no change', 'what do you think so far?');

      // ── Session 2: make it cozier, then undo ──
      say('-- session 2: make it cozier, apply, undo');
      const beforeHers = structuredClone(editorRoom.state);
      await turnLine('cozier', 'make it cozier, your turn');
      const herEvents = events.filter((e) => e.kind === 'edits' && e.mode === 'apply');
      if (herEvents.length) {
        editorRoom = { ...editorRoom, state: beforeHers };
        syncTogether(TOKEN, editorRoom, Date.now());
        say('  [player taps "Undo her changes"]');
      }
      await turnLine('after undo', 'hmm i undid it, i think i liked it before');
      await turnLine('suggest', 'any ideas for the bed? just tell me, dont change it');
      closeTogether(TOKEN);

      // ── Session 3: on a call ──
      say('-- session 3: on a call, the picture');
      setCallActive(CHAR, true);
      editorRoom = savedRoom();
      openTogether(TOKEN, CHAR, editorRoom, { now: Date.now(), onCall: true });
      edit('rug to mustard', (s) => {
        const rug = editorRoom.manifest.components.find((c) => c.slot === 'rug')!;
        return { ...s, slots: { ...s.slots, rug: { id: rug.id, tint: '#d4a73a' } } };
      });
      await turnLine('call 1 (changed)', 'ok look at this, better?', true);
      await turnLine('call 2 (no change)', 'yeah i think so too', true);
      edit('time to night', (s) => ({ ...s, time: 'night' }));
      await turnLine('call 3 (changed, <20s)', 'and with the lights down?', true);
      await new Promise((r) => setTimeout(r, 21_000));
      await turnLine('call 4 (same change, >20s)', 'still there? what do you see', true);
      setCallActive(CHAR, false);
      closeTogether(TOKEN);

      // The transcript: everything landed in her normal chat.
      const recent = await readRecent(CHAR, 60);
      say(`-- her chat transcript has ${recent.length} rows (${recent.filter((m) => m.role === 'companion').length} hers)`);
      for (const m of recent) say(`   ${m.role}${m.voice ? ' (voice)' : ''}: ${m.text}`);
      const byLabel = new Map<string, typeof usage>();
      for (const u of usage) byLabel.set(u.label, [...(byLabel.get(u.label) ?? []), u]);
      say(`-- spend ~$${cost(usage).toFixed(4)} over ${usage.length} calls`);
      for (const [k, rows] of byLabel) say(`   ${k}: $${cost(rows).toFixed(4)} ${JSON.stringify(rows.map(({ label: _l, ...x }) => x))}`);
      await mkdir(OUT, { recursive: true });
      writeFileSync(path.join(OUT, `probe-${name.toLowerCase()}.txt`), log.join('\n') + '\n');
      setRoomSource(null);
      _setUserDataOverride(null);
      await rm(dir, { recursive: true, force: true });
    });
  }
});

void homedir;
