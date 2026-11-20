/**
 * scripts/backseat-cache-probe.ts — per-look prompt-cache usage on a scripted
 * backseat session (261102, free-minute cost work).
 *
 * Free backseat sessions on v0.6.10+ showed cache_read flat at the system
 * prefix and ~900 tokens written to cache on every look. This probe runs a
 * scripted session through the REAL backseat prompt assembly
 * (buildSystemBlocks with BACKSEAT_CONTRACT, the anchored history window,
 * toMessages, markMessageCached on the last history message, then the look
 * turn after the breakpoint), against Haiku 5.5 with thinking disabled as the
 * app sends it, and logs input / cache_read / cache_write / output per look
 * for up to three arms run side by side in real time:
 *
 *   before  dev before 261102: companion rows merged into one growing string,
 *           minute clock in the status block.
 *   blocks  toMessages(..., { appendOnly: true }), clock still in the status block.
 *   after   the current app: appendOnly + clockInTail, the clock stamp at the
 *           end of the look note.
 *
 * The grid image is replaced by a short text placeholder: it sits after the
 * breakpoint in every arm, so it changes the bill by the same plain-input
 * amount and nothing about what is cached. Looks are paced like a live
 * session (--gap, default 12 s) so minute rollovers land where they would.
 * The arms carry a different nonce in the persona so none reads another's
 * cache past block 0.
 *
 * All content is synthetic. Key (dev-only): ANTHROPIC_API_KEY env wins, else
 * ~/.sei-dev/anthropic-test-key; never printed. A default run costs about a
 * cent.
 *
 * Usage: npx tsx scripts/backseat-cache-probe.ts [--looks 16] [--gap 12] [--arms before,blocks,after] [--out file.json]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildSystemBlocks, clockTailNote, markMessageCached, REMEMBER_TOOL } from '../src/main/chat/chatPrompts';
import { toMessages } from '../src/main/chat/transcript';
import { BACKSEAT_CONTRACT } from '../src/main/backseat/backseatPrompts';
import type { ChatMessage } from '../src/shared/ipc';
import { F1, PERSONA_EXPANDED, MEMORY, PLAYER_LINES } from './call-fixture';

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const LOOKS = Number(opt('--looks', '16'));
const GAP_MS = Number(opt('--gap', '12')) * 1000;
type Arm = 'before' | 'blocks' | 'after';
const ARMS = opt('--arms', 'before,blocks,after').split(',') as Arm[];
const OUT = opt('--out', '');
const MODEL = 'claude-haiku-5-5';
/** backseatService RECENT_CAP (not exported): the window re-anchors once it doubles. */
const RECENT_CAP = 12;
/** Every Nth look the player says something (a 'user' tick). */
const USER_EVERY = 5;

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

interface LookLog {
  look: number;
  kind: string;
  rows: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  micro: number;
  reply: string;
}

/** µ$ at Haiku 5.5 list price: $0.10 in, 1.25x write, 0.1x read, $0.50 out per MTok. */
function micro(u: { input_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens: number }): number {
  return u.input_tokens * 0.1 + (u.cache_creation_input_tokens ?? 0) * 0.125 + (u.cache_read_input_tokens ?? 0) * 0.01 + u.output_tokens * 0.5;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runArm(arm: Arm, nonce: string): Promise<LookLog[]> {
  const t0 = Date.now();
  // Earlier typed chat (the F1 batch, shifted to end 3h ago), as the shared thread holds it.
  const lastMin = F1.messages[F1.messages.length - 1].min as number;
  const history: ChatMessage[] = F1.messages.slice(-20).map((m: { role: 'user' | 'companion'; text: string; min: number }, i: number) => ({
    id: `pre-${i}`,
    role: m.role,
    text: m.text,
    ts: t0 - 3 * 3600_000 - (lastMin - m.min) * 60_000,
  }));
  let anchor = -1;
  let p = 0;
  const logs: LookLog[] = [];
  for (let look = 0; look < LOOKS; look++) {
    const due = t0 + look * GAP_MS;
    if (Date.now() < due) await sleep(due - Date.now());
    const kind = look === 0 ? 'start' : look % USER_EVERY === 0 ? 'user' : 'gate';
    const said = kind === 'user' ? PLAYER_LINES[p++ % PLAYER_LINES.length] : '';
    // handleTick persists the player's line before the turn; runTurn drops that tail copy.
    if (said) history.push({ id: `u-${look}`, role: 'user', text: said, ts: Date.now(), voice: true });
    const system = buildSystemBlocks({
      persona: { source: 'x', expanded: `${PERSONA_EXPANDED}\n\n(probe ${nonce}-${arm})` } as any,
      name: 'Sui',
      preferredName: 'Ren',
      proactiveness: 1,
      punctuation: 'casual',
      memory: MEMORY,
      summary: String(F1.existingSummary),
      openWorldDetected: false,
      inGame: false,
      voiceCall: true,
      allowSilence: false,
      voiceSpeech: 'text',
      language: 'en',
      extraStable: BACKSEAT_CONTRACT,
      ...(arm === 'after' ? { clockInTail: true } : {}),
    } as any);
    if (anchor < 0 || history.length - anchor > RECENT_CAP * 2) anchor = Math.max(0, history.length - RECENT_CAP);
    let recent = history.slice(anchor);
    if (said) recent = recent.slice(0, -1);
    const messages = toMessages(recent, arm === 'before' ? {} : { appendOnly: true });
    markMessageCached(messages, messages.length - 1);
    const note =
      `[Look ${look}: a ${kind} tick. The grid shows the player's game; describe nothing you cannot see. ` +
      `(Probe placeholder for the ~1.5k-token image grid.)]`;
    const body = said ? `${note}\n\n${said}` : note;
    messages.push({ role: 'user', content: [{ type: 'text', text: arm === 'after' ? `${body}\n${clockTailNote()}` : body }] });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 100,
      system: system as any,
      tools: [REMEMBER_TOOL] as any,
      messages: messages as any,
      thinking: { type: 'disabled' },
    } as any);
    const u = res.usage as any;
    const text = res.content
      .map((b: any) => (b.type === 'text' ? b.text : ''))
      .join(' ')
      .trim();
    // The companion's line lands in the shared thread, one row per line.
    for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
      history.push({ id: `c-${look}-${Math.random()}`, role: 'companion', text: line, ts: Date.now(), voice: true });
    }
    const log: LookLog = {
      look,
      kind,
      rows: recent.length,
      input: u.input_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens,
      micro: micro(u),
      reply: text.slice(0, 60),
    };
    logs.push(log);
    console.log(
      `${arm.padEnd(6)} l${String(look).padStart(2)} ${kind.padEnd(5)} rows=${String(log.rows).padStart(2)} in=${String(log.input).padStart(5)} ` +
        `read=${String(log.cacheRead).padStart(5)} write=${String(log.cacheWrite).padStart(5)} out=${String(log.output).padStart(3)} ` +
        `${log.micro.toFixed(0).padStart(4)}µ$ ${JSON.stringify(log.reply)}`,
    );
  }
  return logs;
}

function summarize(arm: string, logs: LookLog[]): void {
  // Look 0 pays the cold write on every arm; the steady state is the rest.
  const steady = logs.slice(1);
  const avg = (f: (l: LookLog) => number) => steady.reduce((n, l) => n + f(l), 0) / Math.max(1, steady.length);
  console.log(
    `${arm.padEnd(6)} steady looks=${steady.length} avg in=${avg((l) => l.input).toFixed(0)} read=${avg((l) => l.cacheRead).toFixed(0)} ` +
      `write=${avg((l) => l.cacheWrite).toFixed(0)} out=${avg((l) => l.output).toFixed(0)} cost=${avg((l) => l.micro).toFixed(1)}µ$/look ` +
      `(cache part ${avg((l) => l.cacheWrite * 0.125 + l.cacheRead * 0.01).toFixed(1)}µ$) first=${logs[0].micro.toFixed(0)}µ$`,
  );
}

async function main(): Promise<void> {
  const nonce = Math.random().toString(36).slice(2, 8);
  const results = await Promise.all(ARMS.map((a) => runArm(a, nonce)));
  console.log('');
  ARMS.forEach((a, i) => summarize(a, results[i]));
  if (OUT) writeFileSync(OUT, JSON.stringify(Object.fromEntries(ARMS.map((a, i) => [a, results[i]])), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
