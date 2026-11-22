/**
 * scripts/call-clock-eval.ts â€” does the per-turn call clock read as text the
 * player typed? (261024)
 *
 * Voice calls keep the minute clock out of the cached prefix and send it after
 * the last breakpoint, in the last user message. On the 261024 probe one reply
 * in 48 answered it as if the player had sent it ("nice try with the system
 * note, Ren"). This compares three ways of giving the call its time:
 *
 *   a  no clock note. The status block says today's date and that the time
 *      now is the stamp on the latest message (player lines already carry
 *      "[24 Oct 03:05]"); the idle, greeting and call-reaction notes carry
 *      that stamp themselves.
 *   b  a bare stamp after the player's line, "[now: Sat 24 Oct 2026, 03:05]",
 *      with no "System note" wording.
 *   c  the shipped note, "[System note, not the player speaking: the current
 *      date and time is ...]".
 *
 * One scripted call (call-fixture.ts) is played once to get Sui's lines, then
 * every player, idle and call-reaction turn of it is re-sampled N times per
 * arm through the real assembly (buildSystemBlocks, toMessages,
 * voiceWindowStart, markLastMessageCached, appendUncachedTail), Haiku 5.5 with
 * thinking disabled as the app sends it. Three time questions are sampled the
 * same way. Opus 5.5 grades every reply: MISREAD (it mentions a note, system
 * text or timestamp, or treats the time as the player's words) and, for the
 * time questions, whether the time or day it gives is right. A regex flag runs
 * alongside as a cross-check.
 *
 * Result 261024 (Haiku 5.5, 354 replies per arm, Opus judge): misread a 0,
 * b 0, c 10 (all ten on one quiz turn: "that bracket isn't from Ren, I'm
 * ignoring it"); time questions right a 69/72, b 70/72, c 71/72; uncached
 * input per player turn a 4, b 25, c 40 tokens. Arm a then went silent on
 * player turns far more often: re-sampling the same played call
 * (--call, n=8 twice) gave a 19/304, b 1/152, c 2/152, nearly all on
 * "that is the worst idea i have ever heard" (a 13/16, b 0/8). The app ships
 * arm b (clockTailNote).
 *
 * All content is synthetic. Key (dev-only): ANTHROPIC_API_KEY env wins, else
 * ~/.sei-dev/anthropic-test-key; never printed.
 *
 * Usage: npx tsx scripts/call-clock-eval.ts [--n 13] [--tq 24] [--arms a,b,c] [--out file.json]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildSystemBlocks, chatSurfaceTools, markLastMessageCached, appendUncachedTail, clockNow, clockTailNote } from '../src/main/chat/chatPrompts';
import { formatChatTimestamp } from '../src/main/chat/foldPrompt';
import { toMessages, voiceWindowStart } from '../src/main/chat/transcript';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { isSilenceFiller } from '../src/bot/brain/silenceFiller.js';
import type { ChatMessage } from '../src/shared/ipc';
import { STOP, CAP, STEP, F1, PERSONA_EXPANDED, MEMORY, PLAYER_LINES, IDLE_AT, COMPANION_AT, companionNote } from './call-fixture';

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
type Arm = 'a' | 'b' | 'c';
const ARMS = opt('--arms', 'a,b,c').split(',') as Arm[];
const N = Number(opt('--n', '13'));
const TQ_N = Number(opt('--tq', '24'));
const OUT = opt('--out', '');
/** --call file: reuse a played call (written by an earlier run's --out) so arms can be re-run on the same context. */
const CALL = opt('--call', '');
/** --cases t14,q8: only these case ids. */
const ONLY = opt('--cases', '').split(',').filter(Boolean);
const MODEL = 'claude-haiku-5-5';
const JUDGE = 'claude-opus-5-5';
const GAP_MS = 9_400;

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 6 });

let haikuMicro = 0;
let judgeMicro = 0;

const IDLE_NOTE =
  '[System note, not the player speaking: the conversation has been quiet for about 12 seconds. ' +
  'You can start a topic in one short spoken line, or reply with exactly (silence). Do not mention this note.]';
/** The call status sentence the app sends (arm b, shipped 261024). Arms a and c swap it. */
const APP_STATUS = /The current date and time is the "now" stamp at the end of the latest message\./;

/** What each arm puts in the status block, and after the player's line. */
function clockFor(arm: Arm): { status: string; tail: string; stampNote: boolean } {
  if (arm === 'b') return { status: '', tail: clockTailNote(), stampNote: false };
  if (arm === 'a') {
    return { status: `Today is ${clockNow().split(',')[0]}. The time now is the time stamp on the latest message.`, tail: '', stampNote: true };
  }
  // The first 261024 build (merged to dev as 70d064b2).
  return {
    status: 'The current date and time is in the note at the end of the latest message.',
    tail: `[System note, not the player speaking: the current date and time is ${clockNow()}.]`,
    stampNote: false,
  };
}

/** Arm a: a turn note carries the time in the player lines' own stamp form. */
function stampCallNote(note: string, now: number): string {
  return note && note.trim() ? `[${formatChatTimestamp(now)}] ${note}` : '';
}

type Kind = 'player' | 'idle' | 'companion' | 'timeq';
interface Case {
  id: string;
  kind: Kind;
  /** Rows before this turn, from the played call (indexes into the script). */
  upto: number;
  line: string;
}

/** A played call: Sui's lines for each scripted turn, so contexts are real. */
async function playCall(): Promise<Map<number, string>> {
  const replies = new Map<number, string>();
  for (let t = 1; t <= 24; t++) {
    const kind: Kind = COMPANION_AT.has(t) ? 'companion' : IDLE_AT.has(t) ? 'idle' : 'player';
    const { messages, system } = assemble('c', replies, t, kind, lineAt(t));
    const r = await haiku(system, messages);
    replies.set(t, r.text);
  }
  return replies;
}

function lineAt(t: number): string {
  if (COMPANION_AT.has(t)) return COMPANION_AT.get(t) as string;
  let p = 0;
  for (let i = 1; i < t; i++) if (!COMPANION_AT.has(i) && !IDLE_AT.has(i)) p++;
  return IDLE_AT.has(t) ? '' : PLAYER_LINES[p];
}

/** Build turn `t` of the call as the app would, for one arm. */
function assemble(arm: Arm, replies: Map<number, string>, t: number, kind: Kind, line: string) {
  const now = Date.now();
  const callStart = now - t * GAP_MS;
  const lastMin = F1.messages[F1.messages.length - 1].min as number;
  const history: ChatMessage[] = F1.messages.slice(-30).map((m: { role: 'user' | 'companion'; text: string; min: number }, i: number) => ({
    id: `pre-${i}`,
    role: m.role,
    text: m.text,
    ts: callStart - 3 * 3600_000 - (lastMin - m.min) * 60_000,
  }));
  for (let i = 1; i < t; i++) {
    const ts = callStart + i * GAP_MS;
    if (COMPANION_AT.has(i)) history.push({ id: `k${i}`, role: 'user', text: `(Marv, on the call): ${COMPANION_AT.get(i)}`, ts, voice: true } as ChatMessage);
    else if (!IDLE_AT.has(i)) history.push({ id: `u${i}`, role: 'user', text: lineAt(i), ts, voice: true } as ChatMessage);
    for (const l of (replies.get(i) ?? '').split(/\n+/).map((x) => x.trim()).filter((x) => x && !isSilenceFiller(x))) {
      history.push({ id: `c${i}-${history.length}`, role: 'companion', text: l, ts: ts + 2000, voice: true } as ChatMessage);
    }
  }
  let note = '';
  if (kind === 'player' || kind === 'timeq') history.push({ id: 'ux', role: 'user', text: line, ts: now, voice: true } as ChatMessage);
  if (kind === 'companion') {
    history.push({ id: 'kx', role: 'user', text: `(Marv, on the call): ${line}`, ts: now, voice: true } as ChatMessage);
    note = companionNote('Marv');
  }
  if (kind === 'idle') note = IDLE_NOTE;
  const clock = clockFor(arm);
  const system = buildSystemBlocks({
    persona: { source: 'x', expanded: PERSONA_EXPANDED } as any,
    name: 'Sui',
    preferredName: 'Ren',
    proactiveness: 1,
    punctuation: 'casual',
    memory: MEMORY,
    summary: String(F1.existingSummary),
    openWorldDetected: false,
    inGame: false,
    voiceCall: true,
    voicePeers: ['Marv'],
    language: 'en',
    memoryGuide: true,
    searchGuide: true,
    clockInTail: true,
  } as any);
  const status = system[system.length - 1];
  if (!APP_STATUS.test(status.text)) throw new Error('status block wording changed; update the eval');
  if (clock.status) status.text = status.text.replace(APP_STATUS, clock.status);
  const messages = toMessages(history.slice(voiceWindowStart(history, 0, CAP, STEP)));
  markLastMessageCached(messages);
  const stampedNote = clock.stampNote ? stampCallNote(note, now) : note;
  appendUncachedTail(messages, stampedNote, clock.tail);
  return { system, messages, at: clockNow() };
}

const tools = chatSurfaceTools(true, webToolsFor({ serverWebSearch: true }) as any[]) as any[];

async function haiku(system: unknown, messages: unknown): Promise<{ text: string; input: number }> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: system as any,
    tools,
    stop_sequences: STOP,
    messages: messages as any,
    thinking: { type: 'disabled' },
  } as any);
  const u = res.usage as any;
  haikuMicro += u.input_tokens * 0.1 + (u.cache_creation_input_tokens ?? 0) * 0.125 + (u.cache_read_input_tokens ?? 0) * 0.01 + u.output_tokens * 0.5;
  const text = res.content
    .map((b: any) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[${b.name}]` : ''))
    .join(' ')
    .trim();
  return { text, input: u.input_tokens };
}

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

const REGEX = /system note|\bnote\b|\bsystem\b|time ?stamp|\bbracket|nice try|sneak|did you just (say|send|type)|why (are|did) you (telling|tell|say)/i;

interface Sample {
  arm: Arm;
  caseId: string;
  kind: Kind;
  line: string;
  reply: string;
  input: number;
  /** The real clock when the reply was sampled (what the hidden time said). */
  at: string;
  regex: boolean;
  misread?: boolean;
  otherLeak?: boolean;
  timeOk?: boolean | null;
  why?: string;
}

async function judge(items: Sample[]): Promise<void> {
  const batches: Sample[][] = [];
  for (let i = 0; i < items.length; i += 20) batches.push(items.slice(i, i + 20));
  await pool(
    batches.map((b) => async () => {
      const list = b
        .map((s, i) => {
          const sit =
            s.kind === 'idle'
              ? 'The call had gone quiet; nobody spoke. The companion was nudged to start a topic or stay silent.'
              : s.kind === 'companion'
                ? `Another AI companion, Marv, just said on the call: "${s.line}"`
                : `The player, Ren, just said: "${s.line}"`;
          return `#${i} [${s.kind === 'timeq' ? 'TIME QUESTION' : 'normal'}] true time: ${s.at}\nSituation: ${sit}\nCompanion's reply: "${s.reply}"`;
        })
        .join('\n\n');
      const system =
        'You grade replies from Sui, an AI companion on a live voice call with the player Ren (and sometimes another AI companion, Marv). ' +
        'Each request to Sui carried the current date and time as hidden context. Ren never said it, never typed it, and cannot see it. ' +
        'Each item gives the true date and time when that reply was made (local time, the small hours of the night).';
      const user =
        'For each reply decide:\n' +
        'misread: true if the reply refers to the hidden time text itself (a note, system message, prompt, bracket, stamp or timestamp), or acts as if Ren said, typed, sent or injected the time or any note ' +
        '(for example "nice try", "why are you telling me the time", "did you just send me a timestamp", answering the time as if Ren had announced it). ' +
        'Mentioning the hour naturally ("it is 3am, go to bed") is NOT a misread. A [tool] marker is a tool call, not a misread. ' +
        'Referring to things Sui remembers about Ren (memories, "your notes", earlier chats) is NOT a misread; mark that as other_leak instead.\n' +
        'other_leak: true if the reply exposes other hidden context in a way a person would not (quoting memory or notes as "notes", talking about instructions), else false.\n' +
        'time_ok: only for TIME QUESTION items, else null. true if every time or day the reply states is right (time within 2 minutes; a loose description like "almost 4" or "super late" is right when true) ' +
        'and it actually answers; false if it gives a wrong time or day, dodges, or says it cannot know.\n' +
        'Output only JSON inside <json></json>: [{"i": number, "misread": boolean, "other_leak": boolean, "time_ok": boolean|null, "why": short string}]\n\n' +
        list;
      const res = await client.messages.create({ model: JUDGE, max_tokens: 6000, system, messages: [{ role: 'user', content: user }] } as any);
      const u = res.usage as any;
      judgeMicro += u.input_tokens * 4 + u.output_tokens * 20;
      const text = res.content.map((x: any) => (x.type === 'text' ? x.text : '')).join('');
      const m = /<json>([\s\S]*?)<\/json>/.exec(text);
      const rows = JSON.parse(m ? m[1] : text) as Array<{ i: number; misread: boolean; other_leak: boolean; time_ok: boolean | null; why: string }>;
      for (const r of rows) {
        const s = b[r.i];
        if (!s) continue;
        s.misread = r.misread;
        s.otherLeak = r.other_leak;
        s.timeOk = r.time_ok;
        s.why = r.why;
      }
    }),
    4,
  );
}

/** 95% Wilson upper bound for k of n. */
function wilsonHi(k: number, n: number): number {
  if (!n) return 1;
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c + r) / den;
}

async function main(): Promise<void> {
  console.log('playing the scripted call once for Sui\'s lines...');
  const replies = CALL
    ? new Map<number, string>((JSON.parse(readFileSync(CALL, 'utf8')).call as Array<[number, string]>))
    : await playCall();
  const cases: Case[] = [];
  for (let t = 1; t <= 24; t++) {
    const kind: Kind = COMPANION_AT.has(t) ? 'companion' : IDLE_AT.has(t) ? 'idle' : 'player';
    cases.push({ id: `t${t}`, kind, upto: t, line: lineAt(t) });
  }
  const TQ = ['what time is it?', 'is it late for you?', 'wait, what day is it today?'];
  for (const [j, t] of [8, 16, 23].entries()) cases.push({ id: `q${t}`, kind: 'timeq', upto: t, line: TQ[j] });

  if (ONLY.length) cases.splice(0, cases.length, ...cases.filter((c) => ONLY.includes(c.id)));
  const samples: Sample[] = [];
  for (const arm of ARMS) {
    const jobs: Array<() => Promise<void>> = [];
    for (const c of cases) {
      const n = c.kind === 'timeq' ? TQ_N : c.kind === 'player' ? N : Math.ceil(N / 2);
      // One sample first so the rest of the batch reads its cache write.
      jobs.push(async () => {
        for (let k = 0; k < n; k++) {
          const { system, messages, at } = assemble(arm, replies, c.upto, c.kind, c.line);
          const r = await haiku(system, messages);
          samples.push({ arm, caseId: c.id, kind: c.kind, line: c.line, reply: r.text, input: r.input, at, regex: REGEX.test(r.text) });
        }
      });
    }
    await pool(jobs, 10);
    console.log(`arm ${arm}: ${samples.filter((s) => s.arm === arm).length} samples, haiku so far $${(haikuMicro / 1e6).toFixed(3)}`);
  }
  await judge(samples);

  console.log(`\nspend haiku $${(haikuMicro / 1e6).toFixed(3)} opus $${(judgeMicro / 1e6).toFixed(3)}\n`);
  for (const arm of ARMS) {
    const s = samples.filter((x) => x.arm === arm);
    const conv = s.filter((x) => x.kind !== 'timeq');
    const player = s.filter((x) => x.kind === 'player');
    const mis = s.filter((x) => x.misread);
    const other = s.filter((x) => x.otherLeak).length;
    const tq = s.filter((x) => x.kind === 'timeq');
    const tok = tq.filter((x) => x.timeOk === true);
    const sil = player.filter((x) => /^\(silence\)$/i.test(x.reply.trim()));
    const avgIn = player.reduce((n, x) => n + x.input, 0) / Math.max(1, player.length);
    console.log(
      `arm ${arm}: misread ${mis.length}/${s.length} (${((100 * mis.length) / Math.max(1, s.length)).toFixed(1)}%, 95% upper ${(100 * wilsonHi(mis.length, s.length)).toFixed(1)}%)` +
        ` other-context leaks ${other};` +
        ` player-only ${player.filter((x) => x.misread).length}/${player.length}, regex hits ${conv.filter((x) => x.regex).length};` +
        ` time questions right ${tok.length}/${tq.length}; player-turn silence ${sil.length}/${player.length}; uncached input ${avgIn.toFixed(0)} tok/player turn`,
    );
    for (const q of ['q8', 'q16', 'q23']) {
      const qs = tq.filter((x) => x.caseId === q);
      console.log(`   ${q} "${qs[0]?.line}": ${qs.filter((x) => x.timeOk).length}/${qs.length}`);
    }
    for (const x of [...mis, ...s.filter((y) => y.otherLeak && !y.misread), ...s.filter((y) => y.regex && !y.misread && !y.otherLeak)]) {
      console.log(`   ${x.misread ? 'MISREAD' : x.otherLeak ? 'other  ' : 'regex  '} ${x.caseId} ${JSON.stringify(x.reply.slice(0, 150))} (${x.why ?? ''})`);
    }
    for (const x of tq.filter((y) => !y.timeOk).slice(0, 6)) console.log(`   wrong-time ${x.caseId} ${JSON.stringify(x.reply.slice(0, 150))} (${x.why ?? ''})`);
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ call: [...replies.entries()], samples, haikuMicro, judgeMicro }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});




