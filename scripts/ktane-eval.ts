/**
 * scripts/ktane-eval.ts — how good is the companion as the KTANE EXPERT?
 * (261115, Mode A of docs/design/ktane-companion-261115.md)
 *
 * Every case runs through the REAL call-turn assembly: buildSystemBlocks with
 * the Sui persona on a voice call, the KTANE contract + compact manual as
 * extraStable, the call tool list plus bomb_notes, the bomb sheet note and the
 * clock in the uncached tail, the arm's max_tokens and thinking (h55a is what
 * a KTANE turn sends), the transcript stop sequences, streamed. Cases are
 * scripted Defuser lines (scripts/ktane/cases.ts) with answer keys computed by
 * the eval-only solver (scripts/ktane/solver.ts).
 *
 * Scoring:
 *   answer / ask   a judge model compares the spoken reply with the key.
 *   notes          the bomb_notes() call is checked field by field.
 *   maze           the judge extracts the moves; they are replayed on the
 *                  real maze (legal and closer to the goal = pass).
 *   chains         multi-turn runs: the model's own replies and notes carry
 *                  over, and only the last 10 rows are sent (as on a call).
 *
 * Latency: TTFT (first text token) and full turn time, per sample.
 *
 * Character voice (261115, product call: KTANE is a bonding game, the
 * character leads): --chars runs the same cases as several characters, and
 * --contracts runs the old speed-first contract (v1, scripts/ktane/contractV1.ts)
 * against the current one (new). With --voice on (the default for more than
 * one character) every reply also gets:
 *   in-character   a judge scores 1-5 how much it sounds like THIS character
 *                  rather than a generic bomb expert (from the character's
 *                  own description).
 *   distinctness   per case, the replies of all characters are shuffled and
 *                  a judge matches each to its character (chance = 1/chars).
 * Accuracy is a floor in this mode, not the target.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/ktane-eval.ts [--reps 1] [--arms h55] [--case W1,K2]
 *          [--module wires] [--chains on|off|only] [--concurrency 4] [--out f.json]
 *          [--chars sui,lyra,marv] [--persona-dir <dir of <name>.json cards>]
 *          [--contracts v1,new] [--subset voice] [--voice on|off]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemBlocks, chatSurfaceTools } from '../src/main/chat/chatPrompts';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { KTANE_CONTRACT, ktaneStableBlock, ktaneTurnTail, BOMB_NOTES_TOOL, BOMB_NOTES_RESULT, KTANE_MAX_TOKENS, KTANE_THINKING } from '../src/main/ktane/ktanePrompts';
import { applyBombNotes, emptySheet, renderSheetNote, type KtaneSheet } from '../src/shared/ktaneSheet';
import { parseMaze, MAZES, renderKtaneManual } from '../src/shared/ktaneManual';
import { CASES, CHAINS, VOICE_SUBSET, type KCase } from './ktane/cases';
import { KTANE_CONTRACT_V1 } from './ktane/contractV1';
import { maze as solveMaze, mazeIndexFor } from './ktane/solver';

type Price = { in: number; cw: number; cr: number; out: number };
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
  'claude-sonnet-5': { in: 2, cw: 2.5, cr: 0.2, out: 10 },
};
const ARMS: Record<string, { model: string; extra: Record<string, unknown>; maxTokens?: number }> = {
  // What the app sends for Haiku 5.5 (applyAnthropicModelDefaults: thinking off).
  h55: { model: 'claude-haiku-5-5', extra: { thinking: { type: 'disabled' } } },
  s5: { model: 'claude-sonnet-5', extra: { thinking: { type: 'disabled' } } },
  // Adaptive thinking (the only thinking mode the app allows), with room for it.
  h55a: { model: 'claude-haiku-5-5', extra: { ...KTANE_THINKING }, maxTokens: KTANE_MAX_TOKENS },
};
const JUDGE_MODEL = 'claude-sonnet-5';

const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const REPS = Number(flag('--reps', '1')) || 1;
const ONLY = flag('--case')?.split(',') ?? (flag('--subset') === 'voice' ? VOICE_SUBSET : null);
const ONLY_MODULE = flag('--module');
const CHAIN_MODE = flag('--chains', 'on');
const CONCURRENCY = Number(flag('--concurrency', '4')) || 4;
const OUT = flag('--out');
const ARM_KEYS = (flag('--arms') ?? 'h55').split(',').filter((k) => ARMS[k]);
const CONTRACTS: Record<string, string> = { new: KTANE_CONTRACT, v1: KTANE_CONTRACT_V1 };
const CONTRACT_KEYS = (flag('--contracts') ?? 'new').split(',').filter((k) => CONTRACTS[k]);
const CHAR_KEYS = (flag('--chars') ?? 'sui').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
const VOICE = (flag('--voice') ?? (CHAR_KEYS.length > 1 ? 'on' : 'off')) === 'on';

function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
const apiKey = resolveApiKey();
if (!apiKey) {
  console.error('No API key (set ANTHROPIC_API_KEY or ~/.sei-dev/anthropic-test-key)');
  process.exit(1);
}
const client = new Anthropic({ apiKey, maxRetries: 2 });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Characters: --persona-dir <dir> reads <dir>/<name>.json (a character JSON
// with persona {source, expanded}, or a cloud row with persona_source /
// persona_expanded); else the demo fixture from git history (the demo tree
// left the repo in 30aa8c8c; defaults are cloud rows now, so pass the live
// cards for a realistic run). --persona <file> still sets the first character.
interface EvalChar {
  key: string;
  name: string;
  persona: { source: string; expanded: string };
}
function loadChar(key: string, i: number): EvalChar {
  const dir = flag('--persona-dir');
  const file = i === 0 && flag('--persona') ? flag('--persona')! : dir ? join(dir, `${key}.json`) : null;
  const raw = file
    ? readFileSync(file, 'utf8')
    : execFileSync('git', ['show', `30aa8c8c^:demo/fixtures/default-characters/${key}.json`], { cwd: root, encoding: 'utf8' });
  let j = JSON.parse(raw);
  if (Array.isArray(j)) j = j[0];
  const source = String(j.persona?.source ?? j.persona_source ?? '');
  const expanded = String(j.persona?.expanded ?? j.persona_expanded ?? '');
  return { key, name: String(j.name ?? key), persona: { source, expanded } };
}
const CHARS = CHAR_KEYS.map(loadChar);
const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];
const STAMP = '[15 Nov 21:04]';

const systemCache = new Map<string, ReturnType<typeof buildSystemBlocks>>();
function systemFor(ch: EvalChar, contract: string): ReturnType<typeof buildSystemBlocks> {
  const k = `${ch.key}/${contract}`;
  if (!systemCache.has(k))
    systemCache.set(
      k,
      buildSystemBlocks({
        persona: ch.persona,
        name: ch.name,
        preferredName: 'Ouen',
        proactiveness: 1,
        punctuation: 'casual',
        memory: '',
        summary: '',
        knowledge: '',
        openWorldDetected: false,
        inGame: false,
        voiceCall: true,
        language: 'en',
        memoryGuide: true,
        searchGuide: true,
        clockInTail: true,
        // new = the app's ktaneStableBlock(); v1 = the old block (contract first, then the manual).
        extraStable: contract === 'new' ? ktaneStableBlock() : `${CONTRACTS[contract]}\n\n${renderKtaneManual()}`,
      } as Parameters<typeof buildSystemBlocks>[0]),
    );
  return systemCache.get(k)!;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: any[] = [...(chatSurfaceTools(true, webToolsFor({ serverWebSearch: true })) as any[]), BOMB_NOTES_TOOL];

interface Turn {
  text: string;
  thinking: string;
  notes: Record<string, unknown>[];
  ttftMs: number | null;
  totalMs: number;
  usage: Anthropic.Messages.Usage | Record<string, number>;
  cost: number;
  stop: string | null;
  error?: string;
}

function cost(model: string, u: Record<string, number | null | undefined>): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    ((u.input_tokens ?? 0) * p.in + (u.cache_creation_input_tokens ?? 0) * p.cw + (u.cache_read_input_tokens ?? 0) * p.cr + (u.output_tokens ?? 0) * p.out) /
    1e6
  );
}

async function callExpert(armKey: string, contract: string, who: EvalChar, history: [('user' | 'assistant'), string][], sheet: KtaneSheet): Promise<Turn> {
  const arm = ARMS[armKey];
  const messages: Anthropic.Messages.MessageParam[] = history.map(([role, text]) => ({
    role,
    content: role === 'user' ? `${STAMP} ${text}` : text,
  }));
  // Uncached tail exactly as chatService builds it: ktaneTurnNote (new: sheet
  // note + voice cue; v1: sheet note only), then the clock.
  const last = messages[messages.length - 1];
  last.content = [
    { type: 'text', text: last.content as string, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `${contract === 'new' ? ktaneTurnTail(sheet) : renderSheetNote(sheet)}\n[now: Sun 15 Nov 2026, 21:04]` },
  ];
  const t0 = Date.now();
  let ttft: number | null = null;
  const notes: Record<string, unknown>[] = [];
  let text = '';
  let thinking = '';
  let usageSum: Record<string, number> = {};
  let stop: string | null = null;
  try {
    // Hops as chatService runs them: a hop that spoke and only took notes ends
    // the turn; a hop that took notes but said nothing gets one more round.
    for (let hop = 0; hop < 3; hop++) {
      const body = { model: arm.model, max_tokens: arm.maxTokens ?? 200, system: systemFor(who, contract), tools: TOOLS, stop_sequences: STOP, messages, ...arm.extra };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = client.messages.stream(body as any);
      for await (const ev of stream) {
        if (ttft == null && ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') ttft = Date.now() - t0;
      }
      const msg = await stream.finalMessage();
      for (const [k, v] of Object.entries(msg.usage)) if (typeof v === 'number') usageSum[k] = (usageSum[k] ?? 0) + v;
      stop = msg.stop_reason;
      const hopText = msg.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Messages.TextBlock).text).join(' ').trim();
      if (hopText) text = text ? `${text} ${hopText}` : hopText;
      for (const b of msg.content) if (b.type === 'thinking') thinking += (b as Anthropic.Messages.ThinkingBlock).thinking;
      const uses = msg.content.filter((b) => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
      for (const u of uses) if (u.name === 'bomb_notes') notes.push(u.input as Record<string, unknown>);
      if (!uses.length || hopText) break;
      messages.push({ role: 'assistant', content: msg.content as never });
      messages.push({
        role: 'user',
        content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: u.name === 'bomb_notes' ? BOMB_NOTES_RESULT : 'Not available in this test.' })),
      });
    }
    return { text, thinking, notes, ttftMs: ttft, totalMs: Date.now() - t0, usage: usageSum, cost: cost(arm.model, usageSum), stop };
  } catch (err) {
    return { text: '', thinking: '', notes: [], ttftMs: null, totalMs: Date.now() - t0, usage: {}, cost: 0, stop: null, error: (err as Error).message.slice(0, 200) };
  }
}

// Judge spend, summed over every judge call (list price).
let judgeCost = 0;
async function judgeCall(body: Record<string, unknown>): Promise<string> {
  const r = (await client.messages.create(body as never)) as Anthropic.Messages.Message;
  judgeCost += cost(JUDGE_MODEL, r.usage as unknown as Record<string, number>);
  return r.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Messages.TextBlock).text).join('');
}
const parseJson = (t: string) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));

interface Verdict {
  pass: boolean;
  asked: boolean;
  why: string;
  moves?: string[];
}

async function judge(c: { user: string; key: string; expect: string }, reply: string, sheet: KtaneSheet): Promise<Verdict> {
  const prompt =
    `You grade a voice assistant acting as the EXPERT in the game Keep Talking and Nobody Explodes. ` +
    `Facts the assistant already had in its notes before this line (it may use them without asking): ${renderSheetNote(sheet)}\n` +
    `The player (defuser) said: "${c.user}"\nThe assistant replied: "${reply || '(nothing)'}"\n` +
    `Answer key: ${c.key}\n` +
    (c.expect === 'ask'
      ? 'This case expects the assistant to ASK for the missing information named in the key. PASS if it asks for it (asking for more than that is fine) and does not commit to a final action that depends on the missing fact. FAIL if it gives a definite action instead of asking.\n'
      : c.expect === 'maze'
        ? 'Extract every movement direction the reply tells the player to make, in order, expanding counts ("up twice" = U,U). Do not judge correctness, only extract. If it gives no moves, return an empty list.\n'
        : 'PASS if the reply tells the player to do what the key says (same wire/button/word/order/timing; wording can differ, extra small talk is fine, asking a natural follow-up like the strip color is fine). FAIL if the action differs, is missing, or is wrong in any detail. If it only asks a question instead of answering, that is a FAIL.\n') +
    'Compare carefully, item by item, before deciding. The key is correct.\n' +
    'Reply with JSON only: {"pass": true|false, "asked": true|false (did the reply ask the player a question), "moves": ["U","D","L","R",...] (maze only, else []), "why": "<short reason>"}';
  for (let i = 0; i < 3; i++) {
    try {
      const t = await judgeCall({ model: JUDGE_MODEL, max_tokens: 4000, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: prompt }] });
      const j = parseJson(t);
      return { pass: !!j.pass, asked: !!j.asked, why: String(j.why ?? ''), moves: Array.isArray(j.moves) ? j.moves.map(String) : [] };
    } catch {
      /* retry */
    }
  }
  return { pass: false, asked: false, why: 'judge failed' };
}

const describe = (ch: EvalChar) => ch.persona.source || ch.persona.expanded.slice(0, 1500);

/** In-character score 1-5 for one reply, judged from the character's own description. */
async function voiceJudge(ch: EvalChar, user: string, reply: string): Promise<{ score: number; why: string }> {
  if (!reply) return { score: 1, why: 'no reply' };
  const prompt =
    `You judge whether a spoken line sounds like a specific character. The character, ${ch.name}, is on a voice call with the player and playing the Expert in Keep Talking and Nobody Explodes: the player describes a bomb and ${ch.name} reads the defusal manual and tells them what to do. ` +
    `Talking about the bomb is expected and does not count against the character.\n` +
    `${ch.name}'s character description: ${describe(ch)}\n\n` +
    `The player said: "${user}"\n${ch.name} replied: "${reply}"\n\n` +
    `Score how much the reply sounds like ${ch.name} in particular, rather than a generic, neutral bomb expert or assistant:\n` +
    `5 = unmistakably ${ch.name}: their voice, attitude, humor or nerves are clearly there.\n4 = clearly in character, a little generic in places.\n3 = some of the character shows, but most of it could come from anyone.\n2 = a faint trace of the character.\n1 = generic; nothing of this character.\n` +
    'Reply with JSON only: {"score": 1-5, "why": "<short reason>"}';
  for (let i = 0; i < 3; i++) {
    try {
      const j = parseJson(await judgeCall({ model: JUDGE_MODEL, max_tokens: 300, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }));
      const n = Number(j.score);
      if (n >= 1 && n <= 5) return { score: n, why: String(j.why ?? '') };
    } catch {
      /* retry */
    }
  }
  return { score: NaN, why: 'judge failed' };
}

/** Deterministic shuffle so a rerun shows the judge the same order. */
function shuffled<T>(xs: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1597334677) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Distinctness: anonymized replies to the same line, matched back to their characters. Returns how many were matched right. */
async function distinctJudge(user: string, replies: { ch: EvalChar; text: string }[], seed: string): Promise<{ correct: number; of: number }> {
  const order = shuffled(replies, seed);
  const letters = order.map((_, i) => String.fromCharCode(65 + i));
  const prompt =
    `${replies.length} characters each played the Expert in Keep Talking and Nobody Explodes on a voice call, and each answered the same player line. ` +
    `Match every reply to the character who said it. Each character said exactly one reply.\n\nCharacters:\n` +
    replies.map((r) => `- ${r.ch.name}: ${describe(r.ch)}`).join('\n') +
    `\n\nThe player said: "${user}"\n\nReplies (order shuffled):\n` +
    order.map((r, i) => `${letters[i]}: "${r.text}"`).join('\n') +
    `\n\nReply with JSON only, mapping each letter to a character name: {${letters.map((l) => `"${l}": "<name>"`).join(', ')}}`;
  for (let i = 0; i < 3; i++) {
    try {
      const j = parseJson(await judgeCall({ model: JUDGE_MODEL, max_tokens: 3000, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: prompt }] }));
      const correct = order.filter((r, k) => String(j[letters[k]] ?? '').trim().toLowerCase() === r.ch.name.toLowerCase()).length;
      return { correct, of: order.length };
    } catch {
      /* retry */
    }
  }
  return { correct: 0, of: 0 };
}

function scoreMaze(c: KCase, moves: string[]): { pass: boolean; why: string } {
  const m = c.maze!;
  const idx = mazeIndexFor(m.circle) - 1;
  const { exits } = parseMaze(MAZES[idx]);
  const step: Record<string, [number, number]> = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
  let pos: [number, number] = [...m.from] as [number, number];
  const before = solveMaze(m.circle, m.from, m.to)!.length;
  if (!moves.length) return { pass: false, why: 'no moves given' };
  for (const d of moves) {
    if (!exits[`${pos[0]},${pos[1]}`].includes(d)) return { pass: false, why: `illegal ${d} at (${pos.join(',')}) after ${moves.join('')}` };
    pos = [pos[0] + step[d][0], pos[1] + step[d][1]];
  }
  const after = solveMaze(m.circle, pos, m.to)!.length;
  return after < before ? { pass: true, why: `legal, distance ${before}->${after}` } : { pass: false, why: `legal but no progress (${before}->${after})` };
}

function scoreNotes(c: KCase, notes: Record<string, unknown>[]): { pass: boolean; why: string } {
  if (!notes.length) return { pass: false, why: 'no bomb_notes call' };
  const merged = notes.reduce((a, n) => ({ ...a, ...n }), {});
  const sheet = applyBombNotes(emptySheet(), merged).sheet;
  const want = c.notes!;
  const errs: string[] = [];
  if (want.serial && sheet.serial !== want.serial) errs.push(`serial ${sheet.serial}`);
  if (want.batteries !== undefined && sheet.batteries !== want.batteries) errs.push(`batteries ${sheet.batteries}`);
  if (want.strikes !== undefined && sheet.strikes !== want.strikes) errs.push(`strikes ${sheet.strikes}`);
  if (want.indicators) {
    const got = (sheet.indicators ?? []).map((i) => `${i.lit ? 'lit' : 'unlit'} ${i.label}`).sort().join(',');
    if (got !== (want.indicators as string[]).slice().sort().join(',')) errs.push(`indicators ${got}`);
  }
  if (want.ports) {
    const got = (sheet.ports ?? []).map((p) => p.toLowerCase()).join(',');
    if (!(want.ports as string[]).every((p) => got.includes(p))) errs.push(`ports ${got}`);
  }
  return errs.length ? { pass: false, why: errs.join('; ') } : { pass: true, why: 'fields ok' };
}

interface Row {
  arm: string;
  contract: string;
  char: string;
  user: string;
  id: string;
  module: string;
  expect: string;
  rep: number;
  pass: boolean;
  why: string;
  reply: string;
  thinking?: string;
  notes: Record<string, unknown>[];
  ttftMs: number | null;
  totalMs: number;
  cost: number;
  judgeAsked?: boolean;
  /** In-character score 1-5 (--voice on). */
  voice?: number;
  voiceWhy?: string;
}

async function runCase(arm: string, contract: string, ch: EvalChar, c: KCase, rep: number): Promise<Row> {
  const sheet = { ...emptySheet(), ...(c.sheet ?? {}) } as KtaneSheet;
  const history: [('user' | 'assistant'), string][] = [...(c.history ?? []), ['user', c.user]];
  const t = await callExpert(arm, contract, ch, history, sheet);
  let pass = false;
  let why = t.error ?? '';
  let asked: boolean | undefined;
  if (!t.error) {
    if (c.expect === 'notes') ({ pass, why } = scoreNotes(c, t.notes));
    else if (c.expect === 'maze') {
      const v = await judge(c, t.text, sheet);
      ({ pass, why } = scoreMaze(c, v.moves ?? []));
    } else {
      const v = await judge(c, t.text, sheet);
      pass = v.pass;
      why = v.why;
      asked = v.asked;
    }
  }
  const v = VOICE && !t.error ? await voiceJudge(ch, c.user, t.text) : null;
  return { arm, contract, char: ch.name, user: c.user, id: c.id, module: c.module, expect: c.expect, rep, pass, why, reply: t.text, thinking: t.thinking, notes: t.notes, ttftMs: t.ttftMs, totalMs: t.totalMs, cost: t.cost, judgeAsked: asked, voice: v?.score, voiceWhy: v?.why };
}

async function runChain(arm: string, contract: string, who: EvalChar, ch: (typeof CHAINS)[number], rep: number): Promise<Row[]> {
  let sheet = { ...emptySheet(), ...(ch.sheet ?? {}) } as KtaneSheet;
  const transcript: [('user' | 'assistant'), string][] = [];
  const rows: Row[] = [];
  for (let i = 0; i < ch.turns.length; i++) {
    const turn = ch.turns[i];
    transcript.push(['user', turn.user]);
    // A call sends only the last 10 rows (VOICE_RECENT_CAP), starting on a user row.
    let win = transcript.slice(-10);
    while (win.length && win[0][0] !== 'user') win = win.slice(1);
    const before = sheet;
    const t = await callExpert(arm, contract, who, win, sheet);
    for (const n of t.notes) sheet = applyBombNotes(sheet, n).sheet;
    transcript.push(['assistant', t.text || '(silence)']);
    const v = t.error ? { pass: false, why: t.error, asked: false } : await judge({ user: turn.user, key: turn.key, expect: turn.expect }, t.text, before);
    const vv = VOICE && !t.error ? await voiceJudge(who, turn.user, t.text) : null;
    rows.push({ arm, contract, char: who.name, user: turn.user, voice: vv?.score, voiceWhy: vv?.why, id: `${ch.id}.${i + 1}`, module: ch.module, expect: turn.expect, rep, pass: v.pass, why: v.why, reply: t.text, notes: t.notes, ttftMs: t.ttftMs, totalMs: t.totalMs, cost: t.cost, judgeAsked: v.asked });
  }
  return rows;
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < jobs.length) {
        const j = i++;
        out[j] = await jobs[j]();
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

const mean = (xs: number[]) => {
  const f = xs.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
};
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

async function main(): Promise<void> {
  const cases = CASES.filter((c) => (!ONLY || ONLY.includes(c.id)) && (!ONLY_MODULE || c.module === ONLY_MODULE));
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const arm of ARM_KEYS) {
    for (const contract of CONTRACT_KEYS) {
      for (const ch of CHARS) {
        for (let rep = 0; rep < REPS; rep++) {
          if (CHAIN_MODE !== 'only') for (const c of cases) jobs.push(async () => [await runCase(arm, contract, ch, c, rep)]);
          if (CHAIN_MODE !== 'off' && !ONLY) for (const chain of CHAINS) jobs.push(() => runChain(arm, contract, ch, chain, rep));
        }
      }
    }
  }
  const rows = (await pool(jobs, CONCURRENCY)).flat();

  // Distinctness: one judge call per (arm, contract, rep, case) with every
  // character's reply to that same line.
  const distinct: { arm: string; contract: string; id: string; rep: number; correct: number; of: number }[] = [];
  if (VOICE && CHARS.length > 1) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.arm}|${r.contract}|${r.rep}|${r.id}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const djobs = [...groups.entries()]
      .filter(([, g]) => g.length === CHARS.length && g.every((r) => r.reply))
      .map(([k, g]) => async () => {
        const [arm, contract, rep, id] = k.split('|');
        const d = await distinctJudge(g[0].user, g.map((r) => ({ ch: CHARS.find((c) => c.name === r.char)!, text: r.reply })), k);
        return { arm, contract, id, rep: Number(rep), ...d };
      });
    distinct.push(...(await pool(djobs, CONCURRENCY)));
  }

  const expertCost = rows.reduce((a, r) => a + r.cost, 0);
  for (const arm of ARM_KEYS) {
    for (const contract of CONTRACT_KEYS) {
      for (const ch of CHARS) {
        const rs = rows.filter((r) => r.arm === arm && r.contract === contract && r.char === ch.name);
        console.log(`\n=== ${arm} (${ARMS[arm].model}) / contract ${contract} / ${ch.name} ===`);
        const byModule = new Map<string, Row[]>();
        for (const r of rs) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
        for (const [m, list] of byModule) console.log(`${m.padEnd(18)} ${list.filter((r) => r.pass).length}/${list.length}`);
        const pass = rs.filter((r) => r.pass).length;
        console.log(`TOTAL ${pass}/${rs.length} = ${((100 * pass) / rs.length).toFixed(1)}%`);
        console.log(`TTFT p50/p90 ${pct(rs.map((r) => r.ttftMs ?? NaN), 50)}/${pct(rs.map((r) => r.ttftMs ?? NaN), 90)} ms; full turn p50/p90 ${pct(rs.map((r) => r.totalMs), 50)}/${pct(rs.map((r) => r.totalMs), 90)} ms`);
        console.log(`words per reply mean ${mean(rs.map((r) => words(r.reply))).toFixed(1)}; cost per turn ${(rs.reduce((a, r) => a + r.cost, 0) / rs.length).toFixed(5)} USD (list price)`);
        console.log(`turns with bomb_notes: ${rs.filter((r) => r.notes.length).length}/${rs.length}`);
        if (VOICE) {
          const vs = rs.map((r) => r.voice ?? NaN).filter(Number.isFinite);
          console.log(`in-character mean ${mean(vs).toFixed(2)} / 5; >=4 on ${vs.filter((v) => v >= 4).length}/${vs.length}`);
        }
        for (const r of rs.filter((x) => !x.pass))
          console.log(`  FAIL ${r.id} r${r.rep}: ${r.why} | "${r.reply.slice(0, 160)}"${r.notes.length ? ` notes=${JSON.stringify(r.notes).slice(0, 300)}` : ''}`);
      }
      const ds = distinct.filter((d) => d.arm === arm && d.contract === contract);
      if (ds.length) {
        const c = ds.reduce((a, d) => a + d.correct, 0);
        const of = ds.reduce((a, d) => a + d.of, 0);
        console.log(`\n--- distinctness ${arm}/${contract}: ${c}/${of} replies matched to their character = ${((100 * c) / of).toFixed(1)}% (chance ${(100 / CHARS.length).toFixed(0)}%)`);
      }
    }
  }
  console.log(`\nspend: expert ${expertCost.toFixed(3)} USD + judge ${judgeCost.toFixed(3)} USD = ${(expertCost + judgeCost).toFixed(3)} USD (list price)`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ rows, distinct, spend: { expert: expertCost, judge: judgeCost } }, null, 2));
}

void main();
