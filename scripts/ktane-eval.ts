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
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/ktane-eval.ts [--reps 1] [--arms h55] [--case W1,K2]
 *          [--module wires] [--chains on|off|only] [--concurrency 4] [--out f.json]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemBlocks, chatSurfaceTools } from '../src/main/chat/chatPrompts';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { ktaneStableBlock, BOMB_NOTES_TOOL, BOMB_NOTES_RESULT, KTANE_MAX_TOKENS, KTANE_THINKING } from '../src/main/ktane/ktanePrompts';
import { applyBombNotes, emptySheet, renderSheetNote, type KtaneSheet } from '../src/shared/ktaneSheet';
import { parseMaze, MAZES } from '../src/shared/ktaneManual';
import { CASES, CHAINS, type KCase } from './ktane/cases';
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
const ONLY = flag('--case')?.split(',') ?? null;
const ONLY_MODULE = flag('--module');
const CHAIN_MODE = flag('--chains', 'on');
const CONCURRENCY = Number(flag('--concurrency', '4')) || 4;
const OUT = flag('--out');
const ARM_KEYS = (flag('--arms') ?? 'h55').split(',').filter((k) => ARMS[k]);

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
// The Sui persona: --persona <file> (a character JSON), else the demo fixture
// from git history (the demo tree left the repo in 30aa8c8c; defaults are
// cloud rows now).
function loadPersona(): unknown {
  const p = flag('--persona');
  const raw = p
    ? readFileSync(p, 'utf8')
    : execFileSync('git', ['show', '30aa8c8c^:demo/fixtures/default-characters/sui.json'], { cwd: root, encoding: 'utf8' });
  return JSON.parse(raw).persona;
}
const SUI = loadPersona();
const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];
const STAMP = '[15 Nov 21:04]';

const SYSTEM = buildSystemBlocks({
  persona: SUI,
  name: 'Sui',
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
  extraStable: ktaneStableBlock(),
} as Parameters<typeof buildSystemBlocks>[0]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: any[] = [...(chatSurfaceTools(true, webToolsFor({ serverWebSearch: true })) as any[]), BOMB_NOTES_TOOL];

interface Turn {
  text: string;
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

async function callExpert(armKey: string, history: [('user' | 'assistant'), string][], sheet: KtaneSheet): Promise<Turn> {
  const arm = ARMS[armKey];
  const messages: Anthropic.Messages.MessageParam[] = history.map(([role, text]) => ({
    role,
    content: role === 'user' ? `${STAMP} ${text}` : text,
  }));
  // Uncached tail exactly as chatService builds it: sheet note, then the clock.
  const last = messages[messages.length - 1];
  last.content = [
    { type: 'text', text: last.content as string, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `${renderSheetNote(sheet)}\n[now: Sun 15 Nov 2026, 21:04]` },
  ];
  const t0 = Date.now();
  let ttft: number | null = null;
  const notes: Record<string, unknown>[] = [];
  let text = '';
  let usageSum: Record<string, number> = {};
  let stop: string | null = null;
  try {
    // Hops as chatService runs them: a hop that spoke and only took notes ends
    // the turn; a hop that took notes but said nothing gets one more round.
    for (let hop = 0; hop < 3; hop++) {
      const body = { model: arm.model, max_tokens: arm.maxTokens ?? 200, system: SYSTEM, tools: TOOLS, stop_sequences: STOP, messages, ...arm.extra };
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
      const uses = msg.content.filter((b) => b.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
      for (const u of uses) if (u.name === 'bomb_notes') notes.push(u.input as Record<string, unknown>);
      if (!uses.length || hopText) break;
      messages.push({ role: 'assistant', content: msg.content as never });
      messages.push({
        role: 'user',
        content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: u.name === 'bomb_notes' ? BOMB_NOTES_RESULT : 'Not available in this test.' })),
      });
    }
    return { text, notes, ttftMs: ttft, totalMs: Date.now() - t0, usage: usageSum, cost: cost(arm.model, usageSum), stop };
  } catch (err) {
    return { text: '', notes: [], ttftMs: null, totalMs: Date.now() - t0, usage: {}, cost: 0, stop: null, error: (err as Error).message.slice(0, 200) };
  }
}

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
      const r = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      } as never);
      const t = (r as Anthropic.Messages.Message).content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Messages.TextBlock).text).join('');
      const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      return { pass: !!j.pass, asked: !!j.asked, why: String(j.why ?? ''), moves: Array.isArray(j.moves) ? j.moves.map(String) : [] };
    } catch {
      /* retry */
    }
  }
  return { pass: false, asked: false, why: 'judge failed' };
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
  id: string;
  module: string;
  expect: string;
  rep: number;
  pass: boolean;
  why: string;
  reply: string;
  notes: Record<string, unknown>[];
  ttftMs: number | null;
  totalMs: number;
  cost: number;
  judgeAsked?: boolean;
}

async function runCase(arm: string, c: KCase, rep: number): Promise<Row> {
  const sheet = { ...emptySheet(), ...(c.sheet ?? {}) } as KtaneSheet;
  const history: [('user' | 'assistant'), string][] = [...(c.history ?? []), ['user', c.user]];
  const t = await callExpert(arm, history, sheet);
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
  return { arm, id: c.id, module: c.module, expect: c.expect, rep, pass, why, reply: t.text, notes: t.notes, ttftMs: t.ttftMs, totalMs: t.totalMs, cost: t.cost, judgeAsked: asked };
}

async function runChain(arm: string, ch: (typeof CHAINS)[number], rep: number): Promise<Row[]> {
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
    const t = await callExpert(arm, win, sheet);
    for (const n of t.notes) sheet = applyBombNotes(sheet, n).sheet;
    transcript.push(['assistant', t.text || '(silence)']);
    const v = t.error ? { pass: false, why: t.error, asked: false } : await judge({ user: turn.user, key: turn.key, expect: turn.expect }, t.text, before);
    rows.push({ arm, id: `${ch.id}.${i + 1}`, module: ch.module, expect: turn.expect, rep, pass: v.pass, why: v.why, reply: t.text, notes: t.notes, ttftMs: t.ttftMs, totalMs: t.totalMs, cost: t.cost, judgeAsked: v.asked });
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

async function main(): Promise<void> {
  const cases = CASES.filter((c) => (!ONLY || ONLY.includes(c.id)) && (!ONLY_MODULE || c.module === ONLY_MODULE));
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const arm of ARM_KEYS) {
    for (let rep = 0; rep < REPS; rep++) {
      if (CHAIN_MODE !== 'only') for (const c of cases) jobs.push(async () => [await runCase(arm, c, rep)]);
      if (CHAIN_MODE !== 'off' && !ONLY) for (const ch of CHAINS) jobs.push(() => runChain(arm, ch, rep));
    }
  }
  const rows = (await pool(jobs, CONCURRENCY)).flat();
  for (const arm of ARM_KEYS) {
    const rs = rows.filter((r) => r.arm === arm);
    console.log(`\n=== ${arm} (${ARMS[arm].model}) ===`);
    const byModule = new Map<string, Row[]>();
    for (const r of rs) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
    for (const [m, list] of byModule) console.log(`${m.padEnd(18)} ${list.filter((r) => r.pass).length}/${list.length}`);
    const pass = rs.filter((r) => r.pass).length;
    console.log(`TOTAL ${pass}/${rs.length} = ${((100 * pass) / rs.length).toFixed(1)}%`);
    console.log(`TTFT p50/p90 ${pct(rs.map((r) => r.ttftMs ?? NaN), 50)}/${pct(rs.map((r) => r.ttftMs ?? NaN), 90)} ms; full turn p50/p90 ${pct(rs.map((r) => r.totalMs), 50)}/${pct(rs.map((r) => r.totalMs), 90)} ms`);
    console.log(`cost per turn ${(rs.reduce((a, r) => a + r.cost, 0) / rs.length).toFixed(5)} USD (list price)`);
    const notesRate = rs.filter((r) => r.notes.length).length;
    console.log(`turns with bomb_notes: ${notesRate}/${rs.length}`);
    for (const r of rs.filter((x) => !x.pass))
      console.log(`  FAIL ${r.id} r${r.rep}: ${r.why} | "${r.reply.slice(0, 160)}"${r.notes.length ? ` notes=${JSON.stringify(r.notes).slice(0, 300)}` : ''}`);
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 2));
}

void main();
