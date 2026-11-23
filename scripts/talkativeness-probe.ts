/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scripts/talkativeness-probe.ts — how much does a character talk on a voice
 * call and on Backseat, and does the persona decide it (261123)?
 *
 * Question behind it: can a user get a quiet, few-words companion from the
 * personality alone, or do the base prompts and timers make every character
 * chatter? This runs the REAL chat-surface assembly (buildSystemBlocks, the
 * voice tool list, toMessages, the cache layout, the shipped notes: call
 * greeting, idle starter from promptLibrary.voiceIdleNote, Backseat
 * BACKSEAT_CONTRACT + tickNote) on Haiku 5.5 with thinking disabled, the way
 * the app sends it, for several characters side by side.
 *
 *   call      greeting, then a scripted player (real lines and fillers like
 *             "yeah" / "lol" / "mm"), then a quiet stretch of idle-starter
 *             ticks timed the way useVoiceStore times them (5-60 s, 5-15 s
 *             after an unanswered question, x2 backoff per silent nudge,
 *             cap 8x) on a SIMULATED clock, so lines per quiet minute come out
 *             without waiting.
 *   backseat  the start look, then idle looks over still images (the
 *             fixtures in scripts/fixtures/backseat), one player line in the
 *             middle. Backseat always speaks by design (the cadence is
 *             mechanical, docs/agents/backseat.md), so the number that a
 *             persona can move is words per line.
 *
 * Characters are cloud-row JSON fixtures (persona_expanded, name), the same
 * shape scripts/quality-eval/persona reads; they stay outside the repo.
 *
 *   npx tsx scripts/talkativeness-probe.ts call|backseat --chars DIR \
 *     --only sui,calder [--reps 3] [--out file.jsonl]
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key;
 * never printed. Prints per-character metrics and the total spend.
 */
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  buildSystemBlocks,
  chatSurfaceTools,
  markLastMessageCached,
  markMessageCached,
  appendUncachedTail,
  clockTailNote,
  REMEMBER_TOOL,
} from '../src/main/chat/chatPrompts';
import { toMessages } from '../src/main/chat/transcript';
import { splitReplyParts } from '../src/main/chat/replyParts';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { callGreetingNote, voiceIdleNote } from '../src/bot/brain/promptLibrary.js';
import { isSilenceFiller } from '../src/bot/brain/silenceFiller.js';
import {
  BACKSEAT_CONTRACT,
  BACKSEAT_MEMORY_NOTE,
  SAVE_CLIP_TOOL,
  backseatMaxTokens,
  stripDashes,
  tickNote,
  recentOpeners,
} from '../src/main/backseat/backseatPrompts';
import { IDLE_MIN_MS, IDLE_MAX_MS } from '../src/shared/backseatIpc';
import type { ChatMessage } from '../src/shared/ipc';

const argv = process.argv.slice(2);
const MODE = argv[0];
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CHARS = opt('--chars', '');
const ONLY = opt('--only', 'sui').split(',');
const REPS = Number(opt('--reps', '3'));
const OUT = opt('--out', '');
const IDLE_TICKS = Number(opt('--idle-ticks', '8'));
const MODEL = 'claude-haiku-5-5';
// --strip 'a||b': ablation, delete these exact substrings from the system
// blocks before sending (to find which sentence drives a behaviour).
const STRIP = opt('--strip', '').split('||').filter(Boolean);
const NO_MEMORY = argv.includes('--no-memory');
function strip<T extends { text: string }>(blocks: T[]): T[] {
  for (const b of blocks) for (const x of STRIP) b.text = b.text.split(x).join('');
  return blocks;
}
if (!CHARS || (MODE !== 'call' && MODE !== 'backseat')) {
  console.error('usage: talkativeness-probe.ts call|backseat --chars DIR --only a,b [--reps N]');
  process.exit(2);
}
function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(path.join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

// Haiku 5.5 list price, $ per MTok (scripts/model-ab-probe.ts).
const PRICE = { in: 0.1, write: 0.125, read: 0.01, out: 0.5 };
let spend = 0;
function bill(u: any): void {
  spend +=
    ((u.input_tokens ?? 0) * PRICE.in +
      (u.cache_creation_input_tokens ?? 0) * PRICE.write +
      (u.cache_read_input_tokens ?? 0) * PRICE.read +
      (u.output_tokens ?? 0) * PRICE.out) /
    1e6;
}

interface Char {
  key: string;
  name: string;
  expanded: string;
  source: string;
}
function loadChar(k: string): Char {
  let row = JSON.parse(readFileSync(path.join(CHARS, `${k}.json`), 'utf8'));
  if (Array.isArray(row)) row = row[0];
  return { key: k, name: row.name, expanded: row.persona_expanded, source: row.persona_source ?? '' };
}

const PLAYER = 'Alex';
const MEMORY = [
  `- ${PLAYER} is in their twenties and works late shifts at a bakery.`,
  `- ${PLAYER} has a cat called Biscuit who sits on the keyboard.`,
  `- We played Minecraft together last week and built a small hut by a river.`,
].join('\n');

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniform = (a: number, b: number) => a + Math.random() * (b - a);
/** Seconds a line takes to say out loud (~2.7 words a second, plus a beat). */
const speakS = (line: string) => 0.6 + words(line) / 2.7;

function lineParts(text: string): string[] {
  return splitReplyParts(text, 'casual', true)
    .map((p) => p.text.trim())
    .filter((l) => l && !isSilenceFiller(l));
}

function textOf(content: any[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

interface Row {
  mode: string;
  char: string;
  rep: number;
  kind: string;
  input?: string;
  lines: string[];
  silent: boolean;
  words: number;
  tools: string[];
  simS?: number;
}
const rows: Row[] = [];
function record(r: Row): void {
  rows.push(r);
  if (OUT) appendFileSync(OUT, JSON.stringify(r) + '\n');
  const said = r.silent ? '(silence)' : r.lines.map((l) => JSON.stringify(l)).join(' | ');
  console.log(
    `[${r.char}/${r.rep}] ${r.kind.padEnd(10)} ${r.input ? `<${r.input}> ` : ''}${said}${r.tools.length ? ` {${r.tools.join(',')}}` : ''}`,
  );
}

// ── Voice call ───────────────────────────────────────────────────────────────

// Real lines want an answer; fillers usually do not.
const PLAYER_SCRIPT: Array<{ text: string; kind: 'real' | 'filler' }> = [
  { text: 'hey. long day, just got home from work', kind: 'real' },
  { text: 'yeah', kind: 'filler' },
  { text: 'what have you been up to?', kind: 'real' },
  { text: 'lol', kind: 'filler' },
  { text: 'gonna make some tea, one sec', kind: 'real' },
  { text: 'ok back', kind: 'real' },
  { text: 'mm', kind: 'filler' },
];

const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];

async function callRep(ch: Char, rep: number): Promise<void> {
  const t0 = Date.now();
  let now = t0; // simulated wall clock (ms)
  const history: ChatMessage[] = [];
  const tools = chatSurfaceTools(true, webToolsFor({ serverWebSearch: true }) as any[]) as any[];
  const system = strip(buildSystemBlocks({
    persona: { source: ch.source, expanded: ch.expanded } as any,
    name: ch.name,
    preferredName: PLAYER,
    proactiveness: 1,
    punctuation: 'casual',
    memory: NO_MEMORY ? '' : MEMORY,
    summary: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: true,
    language: 'en',
    memoryGuide: true,
    searchGuide: true,
    clockInTail: true,
  } as any));

  async function turn(note: string): Promise<{ lines: string[]; tools: string[] }> {
    const messages = toMessages(history.slice(-10));
    markLastMessageCached(messages);
    appendUncachedTail(messages, note, clockTailNote());
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: system as any,
      tools,
      stop_sequences: STOP,
      messages: messages as any,
      thinking: { type: 'disabled' },
    } as any);
    bill(res.usage);
    const lines = lineParts(textOf(res.content as any[]));
    for (const l of lines) history.push({ id: `c-${history.length}`, role: 'companion', text: l, ts: now, voice: true } as any);
    const toolNames = (res.content as any[]).filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').map((b) => b.name);
    return { lines, tools: toolNames };
  }

  // Greeting.
  {
    const r = await turn(callGreetingNote({ peers: [], plan: null }));
    record({ mode: 'call', char: ch.key, rep, kind: 'greeting', lines: r.lines, silent: !r.lines.length, words: r.lines.reduce((n, l) => n + words(l), 0), tools: r.tools });
    now += r.lines.reduce((n, l) => n + speakS(l), 0) * 1000;
  }
  // Scripted player.
  for (const p of PLAYER_SCRIPT) {
    now += 3000;
    history.push({ id: `u-${history.length}`, role: 'user', text: p.text, ts: now, voice: true } as any);
    const r = await turn('');
    record({ mode: 'call', char: ch.key, rep, kind: p.kind, input: p.text, lines: r.lines, silent: !r.lines.length, words: r.lines.reduce((n, l) => n + words(l), 0), tools: r.tools });
    now += r.lines.reduce((n, l) => n + speakS(l), 0) * 1000;
  }
  // Quiet stretch: the renderer's idle clock (useVoiceStore idleTick/fireIdleNudge).
  const lastLine = () => [...history].reverse().find((m) => m.role === 'companion')?.text ?? '';
  let streak = 0;
  let questionNudged = false;
  let awaiting = /[?？]["'”’)\]\s]*$/.test(lastLine().trim());
  const quietStart = now;
  for (let i = 0; i < IDLE_TICKS; i++) {
    const questionMode = awaiting && !questionNudged && streak === 0;
    const target = questionMode ? uniform(5_000, 15_000) : uniform(5_000, 60_000);
    const wait = target * Math.min(8, 2 ** streak);
    now += wait;
    if (questionMode) questionNudged = true;
    const r = await turn(voiceIdleNote({ quietSeconds: wait / 1000, awaitingAnswer: questionMode }));
    const spoke = r.lines.length > 0;
    record({
      mode: 'call', char: ch.key, rep, kind: questionMode ? 'idle-q' : 'idle', lines: r.lines, silent: !spoke,
      words: r.lines.reduce((n, l) => n + words(l), 0), tools: r.tools, simS: Math.round((now - quietStart) / 1000),
    });
    now += r.lines.reduce((n, l) => n + speakS(l), 0) * 1000;
    streak = spoke ? 0 : streak + 1;
    if (spoke) {
      awaiting = /[?？]["'”’)\]\s]*$/.test(lastLine().trim());
      questionNudged = false;
    }
    if (r.tools.includes('end_call')) break;
  }
  rows.push({ mode: 'call', char: ch.key, rep, kind: 'quiet-span', lines: [], silent: true, words: 0, tools: [], simS: Math.round((now - quietStart) / 1000) });
  void t0;
}

// ── Backseat ─────────────────────────────────────────────────────────────────

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'backseat');
const IMAGES = ['stardew-farm-1.jpg', 'stardew-farm-2.jpg', 'stardew-farm-3.jpg'].map((f) =>
  readFileSync(path.join(FIX, f)).toString('base64'),
);
const BS_LOOKS = 7; // after the start look
const BS_USER_AT = 4; // look index where the player says something instead
const BS_USER_LINE = 'honestly i have no idea what i am doing with this farm';

async function backseatRep(ch: Char, rep: number): Promise<void> {
  let now = Date.now();
  let lastSpokeAt: number | null = null;
  const history: ChatMessage[] = [];
  const system = strip(buildSystemBlocks({
    persona: { source: ch.source, expanded: ch.expanded } as any,
    name: ch.name,
    preferredName: PLAYER,
    proactiveness: 1,
    punctuation: 'casual',
    memory: NO_MEMORY ? '' : MEMORY,
    summary: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: true,
    allowSilence: false,
    voiceSpeech: 'text',
    language: 'en',
    memoryNote: BACKSEAT_MEMORY_NOTE,
    clockInTail: true,
    extraStable: BACKSEAT_CONTRACT,
  } as any));
  const tools = [SAVE_CLIP_TOOL, REMEMBER_TOOL] as any[];
  let prevImg: string | null = null;
  for (let i = 0; i <= BS_LOOKS; i++) {
    const kind = i === 0 ? 'start' : i === BS_USER_AT ? 'user' : 'idle';
    if (i > 0) now += uniform(IDLE_MIN_MS, IDLE_MAX_MS);
    const img = IMAGES[i % IMAGES.length];
    const messages = toMessages(history.slice(-12), { appendOnly: true });
    if (messages.length) markMessageCached(messages, messages.length - 1);
    const note = tickNote({
      kind: kind as any,
      secondsSinceLastLine: lastSpokeAt ? (now - lastSpokeAt) / 1000 : null,
      sourceName: 'Stardew Valley',
      shareLabel: 'Stardew Valley',
      frameAges: kind === 'start' ? [0.4, 0] : [6, 3, 1.5, 0.6, 0.2, 0],
      ...(prevImg ? { secondsSincePrevGrid: lastSpokeAt ? (now - lastSpokeAt) / 1000 : 20 } : {}),
      recentOpeners: recentOpeners(history.filter((m) => m.role === 'companion').map((m) => m.text)),
    });
    const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    messages.push({
      role: 'user',
      content: [
        ...(prevImg ? [image(prevImg)] : []),
        image(img),
        { type: 'text', text: `${kind === 'user' ? `${note}\n\n${BS_USER_LINE}` : note}\n${clockTailNote()}` },
      ] as any,
    });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: backseatMaxTokens(kind as any),
      system: system as any,
      tools,
      messages: messages as any,
      thinking: { type: 'disabled' },
    } as any);
    bill(res.usage);
    const lines = lineParts(stripDashes(textOf(res.content as any[])));
    const toolNames = (res.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.name);
    if (kind === 'user') history.push({ id: `u-${i}`, role: 'user', text: BS_USER_LINE, ts: now, voice: true } as any);
    for (const l of lines) history.push({ id: `c-${i}-${l.length}`, role: 'companion', text: l, ts: now, voice: true } as any);
    if (lines.length) lastSpokeAt = now;
    prevImg = img;
    record({ mode: 'backseat', char: ch.key, rep, kind, input: kind === 'user' ? BS_USER_LINE : undefined, lines, silent: !lines.length, words: lines.reduce((n, l) => n + words(l), 0), tools: toolNames });
    await sleep(200);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function summarize(): void {
  console.log('\n== summary ==');
  for (const k of ONLY) {
    const mine = rows.filter((r) => r.char === k);
    const kinds = [...new Set(mine.map((r) => r.kind))].filter((x) => x !== 'quiet-span');
    for (const kind of kinds) {
      const rs = mine.filter((r) => r.kind === kind);
      const spoken = rs.filter((r) => !r.silent);
      console.log(
        `${k.padEnd(8)} ${kind.padEnd(10)} n=${String(rs.length).padStart(2)} silent=${(100 * (rs.length - spoken.length) / rs.length).toFixed(0).padStart(3)}% ` +
          `words/turn median=${median(spoken.map((r) => r.words)).toFixed(1)} mean=${mean(spoken.map((r) => r.words)).toFixed(1)}`,
      );
    }
    if (MODE === 'call') {
      const spans = mine.filter((r) => r.kind === 'quiet-span');
      const idle = mine.filter((r) => r.kind === 'idle' || r.kind === 'idle-q');
      const lines = idle.filter((r) => !r.silent).length;
      const minutes = spans.reduce((n, r) => n + (r.simS ?? 0), 0) / 60;
      console.log(`${k.padEnd(8)} quiet stretch: ${lines} lines in ${minutes.toFixed(1)} simulated min = ${(lines / minutes).toFixed(2)} lines/min (${IDLE_TICKS} ticks x ${spans.length} reps)`);
    }
  }
  console.log(`spend: $${spend.toFixed(4)}`);
}

async function main(): Promise<void> {
  const chars = ONLY.map(loadChar);
  for (let rep = 0; rep < REPS; rep++) {
    await Promise.all(chars.map((ch) => (MODE === 'call' ? callRep(ch, rep) : backseatRep(ch, rep))));
  }
  summarize();
}

main().catch((e) => {
  console.error(e);
  console.log(`spend so far: $${spend.toFixed(4)}`);
  process.exit(1);
});
