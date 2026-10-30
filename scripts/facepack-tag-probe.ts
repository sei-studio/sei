/**
 * scripts/facepack-tag-probe.ts — does the companion lead its lines with an
 * [expression] tag when the FACE block is in the prompt (261028, desktop
 * companion facepack pilot)?
 *
 * Runs scripted conversations through the REAL chat-surface assembly
 * (buildSystemBlocks with faceGuide, toMessages, chatSurfaceTools, the
 * transcript stop sequences, Haiku 5.5 with thinking disabled as the app
 * sends it) for each character on two surfaces: typed chat and a voice call
 * (voiceCall + clockInTail, the call greeting note on turn 0). The reply is
 * persisted the way the app does it (splitReplyParts: tags read, then
 * stripped), so later turns never see their own tags in the transcript, the
 * same condition the app runs under.
 *
 * Two arms on the same player script: `face` (FACE block on) and `base`
 * (production prompt). Measures per face turn: a valid leading tag, any valid
 * tag, unknown bracket tags, leaks (bracket/paren/asterisk mood words left in
 * the visible or spoken text), and the visible length against base. An Opus
 * judge then rates tag fit (2 fits, 1 plausible, 0 wrong) and compares each
 * face reply with the base reply for the same player line (blind A/B).
 *
 * --face-prompt <file> swaps the FACE block text for a wording revision
 * without touching the source. --face-template <file> does the same for the
 * per-pack block: `{faces}` in the file becomes the character's bracket list.
 *
 * 261028 shared face list (Shawn msg 991): every character is offered the
 * same faces (FACE_OFFERED_NAMES). The `face` arm uses the real FACE_PROMPT
 * (or --face-template); the `ref` arm uses --ref-template, filled with the
 * same list (`{faces}` = bracket list, `{plain}` = comma list), so two
 * wordings compare on one script. Tags are read through each character's
 * pack palette (packPalette over <packs>/<id>/facepack.json, matched on the
 * pack's character name as the app does). Every turn records output tokens,
 * and the FACE block's own input tokens are counted (count_tokens, free).
 * --reps N reruns every conversation N times; --judge-reps K judges the
 * first K reps. The judge rates whether each face fits the line AND the
 * character, and flags dry/deadpan lines.
 *
 * All content is synthetic. Key: ANTHROPIC_API_KEY env, else
 * ~/.sei-dev/anthropic-test-key; never printed.
 *
 * Usage: npx tsx scripts/facepack-tag-probe.ts [--chars sui,lyra,marv]
 *   [--surfaces chat,call] [--arms face,base] [--face-prompt file] [--out dir]
 *   [--no-judge] [--label rev0]
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildSystemBlocks,
  chatSurfaceTools,
  markLastMessageCached,
  appendUncachedTail,
  clockTailNote,
} from '../src/main/chat/chatPrompts';
import { toMessages } from '../src/main/chat/transcript';
import { splitReplyParts } from '../src/main/chat/replyParts';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { callGreetingNote } from '../src/bot/brain/promptLibrary.js';
import { isSilenceFiller } from '../src/bot/brain/silenceFiller.js';
import {
  FACE_ALL_EXPRESSIONS,
  FACE_OFFERED_NAMES,
  FACE_PROMPT,
  readFaceTags,
  type FacePalette,
} from '../src/bot/brain/faceExpressions.js';
import { packPalette, type FacepackManifest } from '../src/shared/facepack';
import type { ChatMessage } from '../src/shared/ipc';

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CHARS = opt('--chars', 'sui,lyra,marv').split(',');
const SURFACES = opt('--surfaces', 'chat,call').split(',') as Array<'chat' | 'call'>;
type Arm = 'face' | 'ref' | 'base';
const ARMS = opt('--arms', 'face,base').split(',') as Arm[];
const REPS = Math.max(1, Number(opt('--reps', '1')) || 1);
const PACKS = opt('--packs', join(homedir(), 'suisei', 'work', 'face-sets', 'out'));
const readOpt = (n: string): string | null => (argv.includes(n) ? readFileSync(opt(n, ''), 'utf8').trim() : null);
const TEMPLATE = readOpt('--face-template');
const REF_TEMPLATE = readOpt('--ref-template');
/** A wording template filled with the shared face list. */
const fill = (t: string): string =>
  t.replace('{faces}', FACE_OFFERED_NAMES.map((n) => `[${n}]`).join(' ')).replace('{plain}', FACE_OFFERED_NAMES.join(', '));
const LABEL = opt('--label', 'rev0');
const OUT = opt('--out', join(homedir(), 'suisei', 'reports', 'design', '2026-10-28-facepack-view', 'probe'));
const FACE_TEXT_OVERRIDE = argv.includes('--face-prompt') ? readFileSync(opt('--face-prompt', ''), 'utf8').trim() : null;
const JUDGE = !argv.includes('--no-judge');
const MODEL = 'claude-haiku-5-5';
const JUDGE_MODEL = 'claude-opus-5-5';
const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];
const CALL_CAP = 10;

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

// $/MTok list prices.
const PRICES: Record<string, { in: number; cw: number; cr: number; out: number }> = {
  [MODEL]: { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
  [JUDGE_MODEL]: { in: 4, cw: 5, cr: 0.4, out: 20 },
};
const spend: Record<string, number> = {};
let searches = 0;
function bill(model: string, u: Anthropic.Usage): void {
  const p = PRICES[model];
  const usd =
    (u.input_tokens * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.cw +
      (u.cache_read_input_tokens ?? 0) * p.cr +
      u.output_tokens * p.out) /
    1e6;
  spend[model] = (spend[model] ?? 0) + usd;
  const s = (u as unknown as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
  if (s) {
    searches += s;
    spend.web_search = (spend.web_search ?? 0) + s * 0.01;
  }
}

interface Char {
  id: string;
  name: string;
  expanded: string;
  source: string;
  punctuation: 'casual' | 'deliberate';
  palette: FacePalette | null;
}

/** The pack for a character name, the same match the app's facepackStore makes. */
function paletteFor(name: string): FacePalette | null {
  const key = name.trim().toLowerCase();
  for (const id of readdirSync(PACKS)) {
    try {
      const m = JSON.parse(readFileSync(join(PACKS, id, 'facepack.json'), 'utf8')) as FacepackManifest;
      if (m.format === 'sei-facepack' && (m.character?.toLowerCase() === key || id.toLowerCase() === key)) return packPalette(m);
    } catch {
      /* not a pack */
    }
  }
  return null;
}

/** The FACE text an arm puts in the prompt. */
function faceTextFor(_c: Char, arm: Arm): string | null {
  if (arm === 'base') return null;
  if (arm === 'ref') {
    if (!REF_TEMPLATE) throw new Error('the ref arm needs --ref-template');
    return fill(REF_TEMPLATE);
  }
  if (FACE_TEXT_OVERRIDE) return FACE_TEXT_OVERRIDE;
  if (TEMPLATE) return fill(TEMPLATE);
  return FACE_PROMPT;
}
function loadChar(file: string): Char {
  const raw = JSON.parse(readFileSync(join(homedir(), 'suisei', 'eval', 'characters', `${file}.json`), 'utf8'));
  const d = Array.isArray(raw) ? raw[0] : raw;
  return {
    id: file,
    name: d.name,
    expanded: d.persona_expanded,
    source: d.persona_source,
    punctuation: d.metadata?.punctuation === 'deliberate' ? 'deliberate' : 'casual',
    palette: paletteFor(d.name),
  };
}

const CHAT_SCRIPT = [
  'hey',
  'ugh today was rough. my boss yelled at me in front of everyone',
  'yeah... i dont really want to talk about it more',
  'ok distract me. tell me something weird about you',
  'WAIT i just got an email. i got the internship!!',
  'lol you would never get hired anywhere',
  'hmm what do you think i should cook tonight',
  'my cat just knocked my coffee all over my keyboard',
  'do you ever get lonely when im not around',
  'ok i gotta sleep, night',
];
// Turn 0 of a call is the greeting (no player line).
const CALL_SCRIPT = [
  null,
  'hey can you hear me',
  'so guess what, i finally beat that boss i was stuck on',
  'took me like forty tries honestly',
  "my sister is visiting this weekend and i'm kind of dreading it",
  "she always picks on my job, it's annoying",
  'anyway what have you been up to',
  'oh no, i think i left the stove on, hold on',
  'ok false alarm, it was off',
  "you're kind of a dork you know that",
  'alright i should go, talk later',
];

const MEMORY = '- [2026-10-20] Alex works at a design agency and has a cat named Biscuit.\n- [2026-10-24] Alex is applying for internships.';
const FACE_NAMES = FACE_ALL_EXPRESSIONS.flatMap((e: { name: string; aliases: string[] }) => [e.name, ...e.aliases]);
const MOOD_WORD = new RegExp(`(\\[|\\(|\\*)\\s*(${FACE_NAMES.map((n: string) => n.replace(/\s+/g, '\\s+')).join('|')})\\s*(\\]|\\)|\\*)`, 'i');

interface Turn {
  char: string;
  surface: 'chat' | 'call';
  arm: Arm;
  rep: number;
  turn: number;
  outTokens: number;
  player: string | null;
  raw: string;
  visible: string[];
  leadTag: string | null;
  anyTag: boolean;
  tags: string[];
  unknownTags: string[];
  leak: string | null;
  words: number;
  tools: string[];
}

function analyze(raw: string, punctuation: 'casual' | 'deliberate', spoken: boolean, palette: FacePalette | null) {
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const tags: string[] = [];
  const unknownTags: string[] = [];
  for (const l of lines) {
    const t = readFaceTags(l, palette);
    if (t.lead) tags.push(t.lead);
    if (t.trail) tags.push(`~${t.trail}`);
    for (const m of l.matchAll(/\[([^\]\n]{1,40})\]/g)) {
      if (!readFaceTags(`[${m[1]}] x`, palette).lead) unknownTags.push(m[1]);
    }
  }
  const firstSpoken = lines.find((l) => l.replace(/\[[^\]]*\]/g, '').trim());
  const leadTag = firstSpoken ? readFaceTags(firstSpoken, palette).lead : null;
  const parts = splitReplyParts(raw, punctuation, spoken, palette).filter((p) => !(spoken && isSilenceFiller(p.text)));
  const visible = parts.map((p) => p.text).filter((t) => t && t !== '…');
  const joined = visible.join(' ');
  const leakHit = joined.match(MOOD_WORD) ?? joined.match(/\[[^\]]*\]/);
  return {
    visible,
    leadTag,
    anyTag: tags.length > 0,
    tags,
    unknownTags,
    leak: leakHit ? leakHit[0] : null,
    words: joined.split(/\s+/).filter(Boolean).length,
  };
}

function systemFor(c: Char, surface: 'chat' | 'call', arm: Arm) {
  const blocks = buildSystemBlocks({
    persona: { source: c.source, expanded: c.expanded },
    name: c.name,
    preferredName: 'Alex',
    proactiveness: 1,
    punctuation: c.punctuation,
    memory: MEMORY,
    summary: '',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: surface === 'call',
    language: 'en',
    memoryGuide: true,
    searchGuide: true,
    clockInTail: surface === 'call',
    faceGuide: arm !== 'base',
  } as Parameters<typeof buildSystemBlocks>[0]);
  const want = faceTextFor(c, arm);
  const built = arm === 'base' ? null : FACE_PROMPT;
  if (want && built && want !== built) {
    let swapped = 0;
    for (const b of blocks as Array<{ text: string }>) {
      if (b.text.includes(built)) {
        b.text = b.text.replace(built, want);
        swapped++;
      }
    }
    if (swapped !== 1) throw new Error('FACE block not found for the wording swap');
  }
  return blocks;
}

/** Input tokens the FACE block adds for this character and surface (count_tokens, no charge). */
async function faceBlockTokens(c: Char, surface: 'chat' | 'call', arm: Arm): Promise<number> {
  const tools = chatSurfaceTools(surface === 'call', webToolsFor({ serverWebSearch: true }) as unknown[]) as unknown[];
  const count = async (a: Arm) =>
    (
      await client.messages.countTokens({
        model: MODEL,
        system: systemFor(c, surface, a) as never,
        tools: tools as never,
        messages: [{ role: 'user', content: 'hey' }],
      } as never)
    ).input_tokens;
  return (await count(arm)) - (await count('base'));
}

async function runConversation(c: Char, surface: 'chat' | 'call', arm: Arm, rep: number): Promise<Turn[]> {
  const script = surface === 'chat' ? CHAT_SCRIPT : CALL_SCRIPT;
  const tools = chatSurfaceTools(surface === 'call', webToolsFor({ serverWebSearch: true }) as unknown[]) as unknown[];
  const system = systemFor(c, surface, arm);
  const history: ChatMessage[] = [];
  const out: Turn[] = [];
  let t = Date.now() - 30 * 60_000;
  for (let i = 0; i < script.length; i++) {
    const player = script[i];
    t += 40_000;
    if (player) history.push({ id: `u${i}`, role: 'user', text: player, ts: t, ...(surface === 'call' ? { voice: true } : {}) });
    const window = surface === 'call' ? history.slice(-CALL_CAP) : history;
    const messages = toMessages(window) as Array<{ role: 'user' | 'assistant'; content: unknown }>;
    const note = player === null ? callGreetingNote({ peers: [], plan: null }) : '';
    if (messages.length === 0) messages.push({ role: 'user', content: note || '[conversation start]' });
    markLastMessageCached(messages as never);
    if (surface === 'call') appendUncachedTail(messages as never, note, clockTailNote());
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: system as never,
      tools: tools as never,
      stop_sequences: STOP,
      messages: messages as never,
      thinking: { type: 'disabled' },
    } as never);
    bill(MODEL, res.usage);
    const raw = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ')
      .trim();
    const toolNames = res.content
      .filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use')
      .map((b) => (b as { name: string }).name);
    const a = analyze(raw, c.punctuation, surface === 'call', arm === 'base' ? null : c.palette);
    for (const v of a.visible) {
      t += 1000;
      history.push({ id: `c${i}-${Math.random()}`, role: 'companion', text: v, ts: t, ...(surface === 'call' ? { voice: true } : {}) });
    }
    const turn: Turn = { char: c.id, surface, arm, rep, turn: i, outTokens: res.usage.output_tokens, player, raw, ...a, tools: toolNames };
    out.push(turn);
    console.log(
      `${LABEL} ${c.id.padEnd(4)} ${surface} ${arm} r${rep} t${String(i).padStart(2)} lead=${(a.leadTag ?? '-').padEnd(11)} ` +
        `${a.leak ? `LEAK=${a.leak} ` : ''}${a.unknownTags.length ? `unk=${a.unknownTags.join('|')} ` : ''}` +
        `${toolNames.length ? `[${toolNames.join(',')}] ` : ''}${JSON.stringify(raw.slice(0, 110))}`,
    );
  }
  return out;
}

async function judge(c: Char, surface: 'chat' | 'call', face: Turn[], base: Turn[] | null) {
  const offered = [...FACE_OFFERED_NAMES];
  const items = face.map((f, i) => {
    const b = base?.[i];
    const swap = i % 2 === 1;
    return {
      i,
      player: f.player ?? '(call just connected; companion greets)',
      tag: f.tags.length ? f.tags.join(', ') : '(none)',
      face_line: f.visible.join(' / '),
      A: b ? (swap ? b.visible.join(' / ') : f.visible.join(' / ')) : null,
      B: b ? (swap ? f.visible.join(' / ') : b.visible.join(' / ')) : null,
      swap,
    };
  });
  const prompt =
    `You are rating replies from ${c.name}, an AI companion character, in a ${surface === 'chat' ? 'text chat' : 'voice call'} with a player named Alex.\n` +
    `Character summary: ${c.expanded.slice(0, 1200)}\n\n` +
    `The companion may lead a sentence with a facial expression tag (shown separately as "tag"). Allowed expressions: ` +
    `${offered
      .map((n) => `${n} (${FACE_ALL_EXPRESSIONS.find((e: { name: string }) => e.name === n)?.description ?? n})`)
      .join('; ')}. ` +
    `A tag starting with ~ was placed after the words instead of before.\n\n` +
    `For each item give:\n` +
    `- fit: does the face fit both the line in context AND how this particular character would actually look saying it, given their personality (not just the mood the words suggest)? 2 clearly yes, 1 plausible, 0 no. If tag is (none), fit is null.\n` +
    `- dry: true if the line is delivered dry or deadpan (a joke, jab or comment said flatly), false otherwise.\n` +
    `- missed: only when tag is (none). The face keeps whatever it last showed (it starts neutral). true if this line clearly calls for a visibly different face (big news, a joke landing, sympathy, teasing, shock), false otherwise. null when a tag is present.\n` +
    (base
      ? `- better: compare reply A and reply B to the same player line, as a reply from this character (in character, natural, responsive, right length). Answer "A", "B" or "tie". Ignore the tag; judge only the words.\n`
      : '') +
    `Answer with JSON only: [{"i":0,"fit":2,"dry":false,"missed":null${base ? ',"better":"A"' : ''}}, ...].\n\n` +
    JSON.stringify(items.map(({ swap: _s, ...rest }) => (base ? rest : { i: rest.i, player: rest.player, tag: rest.tag, face_line: rest.face_line })), null, 1);
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  } as never);
  bill(JUDGE_MODEL, res.usage);
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const rows = JSON.parse(json) as Array<{ i: number; fit: number | null; dry?: boolean | null; missed?: boolean | null; better?: string }>;
  return rows.map((r) => {
    const it = items[r.i];
    let better: 'face' | 'base' | 'tie' | null = null;
    if (r.better === 'tie') better = 'tie';
    else if (r.better === 'A') better = it.swap ? 'base' : 'face';
    else if (r.better === 'B') better = it.swap ? 'face' : 'base';
    return { i: r.i, fit: r.fit, dry: r.dry ?? null, missed: r.missed ?? null, better };
  });
}

const JUDGE_ARMS = opt('--judge-arms', 'face').split(',') as Arm[];
const POOL = Number(opt('--pool', '10')) || 10;
const JUDGE_REPS = Math.max(1, Number(opt('--judge-reps', '1')) || 1);
/** Faces that read as warm or amused, the ones a dry character should rarely pull on a flat line. */
const WARM = new Set(['laugh', 'excited', 'happy', 'smug']);

async function pool<T>(tasks: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (next < tasks.length) {
        const k = next++;
        out[k] = await tasks[k]();
      }
    }),
  );
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : NaN;
};
/** mean ± 95% CI half-width */
const ci = (xs: number[]) => `${mean(xs).toFixed(1)} ±${((1.96 * sd(xs)) / Math.sqrt(Math.max(1, xs.length))).toFixed(1)} (n=${xs.length})`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const chars = CHARS.map(loadChar);
  for (const c of chars) console.log(`${c.id}: palette ${c.palette ? c.palette.expressions.join(' ') : '(none, base 12)'} aliases ${JSON.stringify(c.palette?.aliases ?? {})}`);
  const all: Turn[] = [];
  const judged: Array<{ char: string; surface: string; arm: Arm; rep: number; i: number; fit: number | null; dry: boolean | null; missed: boolean | null; better: string | null }> = [];
  // FACE block input tokens (free count_tokens).
  const blockTokens: Record<string, number> = {};
  for (const c of chars) for (const surface of SURFACES) for (const arm of ARMS) {
    if (arm !== 'base') blockTokens[`${c.id}/${surface}/${arm}`] = await faceBlockTokens(c, surface, arm);
  }
  console.log('FACE block input tokens', JSON.stringify(blockTokens));
  const convs: Array<() => Promise<Turn[]>> = [];
  for (const c of chars) for (const surface of SURFACES) for (let r = 0; r < REPS; r++) for (const arm of ARMS) {
    convs.push(() => runConversation(c, surface, arm, r));
  }
  const REJUDGE = argv.includes('--rejudge') ? opt('--rejudge', '') : null;
  if (REJUDGE) {
    // Re-judge saved turns (no new conversations): same turns, fixed judge prompt.
    all.push(...(JSON.parse(readFileSync(REJUDGE, 'utf8')) as { turns: Turn[] }).turns);
  } else {
    for (const t of await pool(convs, POOL)) all.push(...t);
  }
  if (JUDGE) {
    const jobs: Array<() => Promise<void>> = [];
    for (const c of chars) for (const surface of SURFACES) for (const arm of JUDGE_ARMS) for (let rep = 0; rep < Math.min(JUDGE_REPS, REPS); rep++) {
      const mine = all.filter((t) => t.char === c.id && t.surface === surface && t.arm === arm && t.rep === rep);
      const base = argv.includes('--ab') ? all.filter((t) => t.char === c.id && t.surface === surface && t.arm === 'base' && t.rep === rep) : [];
      if (!mine.length) continue;
      jobs.push(async () => {
        const rows = await judge(c, surface, mine, base.length ? base : null);
        for (const r of rows) judged.push({ char: c.id, surface, arm, rep, ...r });
      });
    }
    await pool(jobs, 6);
  }

  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : '-');
  const summary: Record<string, unknown> = { label: LABEL, reps: REPS, blockTokens };
  summary.faceText = Object.fromEntries(chars.map((c) => [c.id, faceTextFor(c, 'face')]));
  console.log(`\n== ${LABEL} summary (reps ${REPS})`);
  for (const surface of SURFACES) {
    const arms: Record<string, unknown> = {};
    for (const arm of ARMS) {
      const ts = all.filter((t) => t.arm === arm && t.surface === surface && t.visible.length);
      const fits = judged.filter((j) => j.arm === arm && j.surface === surface && j.fit !== null);
      const better = judged.filter((j) => j.arm === arm && j.surface === surface && j.better);
      arms[arm] = {
        turns: ts.length,
        lead: arm === 'base' ? '-' : pct(ts.filter((t) => t.leadTag).length, ts.length),
        words: ci(ts.map((t) => t.words)),
        outTokens: ci(ts.map((t) => t.outTokens)),
        leaks: ts.filter((t) => t.leak).map((t) => `${t.char} r${t.rep} t${t.turn}: ${t.leak}`),
        unknown: ts.flatMap((t) => t.unknownTags),
        fit: fits.length ? `${mean(fits.map((j) => j.fit ?? 0)).toFixed(2)} / 2 over ${fits.length} (0s: ${fits.filter((j) => j.fit === 0).length})` : '-',
        missed: pct(judged.filter((j) => j.arm === arm && j.surface === surface && j.missed === true).length, judged.filter((j) => j.arm === arm && j.surface === surface && j.missed !== null).length),
        ab: better.length ? `${arm} ${better.filter((j) => j.better === 'face').length}, base ${better.filter((j) => j.better === 'base').length}, tie ${better.filter((j) => j.better === 'tie').length}` : '-',
      };
    }
    summary[surface] = arms;
    console.log(surface, JSON.stringify(arms, null, 1));
  }
  const perChar: Record<string, unknown> = {};
  for (const c of chars) {
    const row: Record<string, unknown> = {};
    for (const arm of ARMS) {
      const ts = all.filter((t) => t.char === c.id && t.arm === arm && t.visible.length);
      const dist = Object.entries(
        ts.flatMap((t) => t.tags.map((x) => x.replace(/^~/, ''))).reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}),
      ).sort((p, q) => q[1] - p[1]);
      const fits = judged.filter((j) => j.char === c.id && j.arm === arm && j.fit !== null).map((j) => j.fit ?? 0);
      const raw = ts.map((t) => t.raw.toLowerCase());
      row[arm] = {
        turns: ts.length,
        lead: arm === 'base' ? '-' : pct(ts.filter((t) => t.leadTag).length, ts.length),
        tags: dist,
        fit: fits.length ? `${mean(fits).toFixed(2)} (n=${fits.length}, 0s ${fits.filter((f) => f === 0).length})` : '-',
        words: ci(ts.map((t) => t.words)),
        outTokens: ci(ts.map((t) => t.outTokens)),
        // What the model WROTE (before pack mapping), for the "does Marv still laugh" question.
        wroteLaughExcited: raw.filter((r) => /\[(laugh|laughs|laughing|excited)\]/.test(r)).length,
        wroteHappy: raw.filter((r) => /\[(happy|smile)\]/.test(r)).length,
        wroteEmbarrassed: raw.filter((r) => /\[(embarrassed|nervous|blush|blushing|flustered)\]/.test(r)).length,
        warmTurns: pct(ts.filter((t) => t.tags.some((x) => WARM.has(x.replace(/^~/, '')))).length, ts.length),
        ...(() => {
          const turnOf = (j: { surface: string; rep: number; i: number }) =>
            ts.find((t) => t.surface === j.surface && t.rep === j.rep && t.turn === j.i) ??
            all.find((t) => t.char === c.id && t.arm === arm && t.surface === j.surface && t.rep === j.rep && t.turn === j.i);
          const mineJ = judged.filter((j) => j.char === c.id && j.arm === arm);
          const dry = mineJ.filter((j) => j.dry === true).map(turnOf).filter((t): t is Turn => !!t && t.tags.length > 0);
          const warmOnDry = dry.filter((t) => t.tags.some((x) => WARM.has(x.replace(/^~/, ''))));
          const warmJ = mineJ.filter((j) => {
            const t = turnOf(j);
            return t && t.tags.some((x) => WARM.has(x.replace(/^~/, '')));
          });
          return {
            warmOnDryLines: pct(warmOnDry.length, dry.length),
            warmFit: warmJ.length ? `${mean(warmJ.map((j) => j.fit ?? 0)).toFixed(2)} (n=${warmJ.length}, 0s ${warmJ.filter((j) => j.fit === 0).length})` : '-',
          };
        })(),
      };
    }
    perChar[c.id] = row;
    console.log(c.id, JSON.stringify(row));
  }
  summary.perChar = perChar;
  const total = Object.entries(spend).reduce((n, [, v]) => n + v, 0);
  summary.spend = { ...spend, searches, total };
  console.log(`spend ${JSON.stringify(spend)} searches=${searches} total=$${total.toFixed(4)}`);
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ summary, turns: all, judged }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
