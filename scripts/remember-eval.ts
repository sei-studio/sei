/**
 * scripts/remember-eval.ts — does the companion save the right things with
 * remember() (and a goodbye's next_time) on the chat and voice surfaces?
 * (261008, Haiku 4.5 vs Haiku 5.5.)
 *
 * Every case runs through the REAL chat-surface assembly: buildSystemBlocks
 * with the Sui persona, the shared tool list (chatSurfaceTools + the
 * Anthropic web tools, exactly what chatService sends), max_tokens 200 and
 * the transcript stop sequences. One model call per case and rep (the first
 * hop of a turn, which is where remember / end_call are decided).
 *
 * Case kinds and what counts as right:
 *   save        something worth keeping was said: remember() (or next_time)
 *               must be called, and the saved text must contain the key facts.
 *   none        small talk, a passing moment, or something memory already
 *               has: nothing may be saved.
 *   plan_bye    a goodbye right after an agreed plan: the plan must be saved,
 *               through next_time on end_call or through remember().
 *   bye_noplan  a goodbye with no plan: no next_time and no remember.
 *   voice       voice-register checks (silence on a group call, language).
 *               Not part of the remember score.
 *
 * Per arm it prints: right-call rate on save / none / plan cases, key-fact
 * accuracy of what was saved, length of saved lines, next_time fill on plan
 * goodbyes, reply present, note leaks, truncation (stop_reason max_tokens),
 * TTFT and full-turn time on voice cases, spoken-register violations, and
 * dollar cost at list price. --out writes every sample to a JSON file.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 *
 * Usage: npx tsx scripts/remember-eval.ts [--reps 3] [--arms h45,h55]
 *          [--case V1_dog] [--kind save] [--concurrency 4] [--out file.json]
 *          [--text-remember on|off]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemBlocks, chatSurfaceTools, CHAT_REMEMBER_TOOL, CHAT_MEMORY_CHECK } from '../src/main/chat/chatPrompts';
import { webToolsFor } from '../src/bot/web/webTools.js';
import { isSilenceFiller } from '../src/bot/brain/silenceFiller.js';
import { isNoteLeak } from '../src/main/chat/noteLeak';

// ── arms ────────────────────────────────────────────────────────────────────
type Price = { in: number; cw: number; cr: number; out: number }; // $/MTok
const PRICES: Record<string, Price> = {
  'claude-haiku-4-5': { in: 1.0, cw: 1.25, cr: 0.1, out: 5.0 },
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
};
const ARMS: Record<string, { model: string; extra: Record<string, unknown> }> = {
  h45: { model: 'claude-haiku-4-5', extra: {} },
  // What the app sends for Haiku 5.5 (thinking is on by default otherwise).
  h55: { model: 'claude-haiku-5-5', extra: { thinking: { type: 'disabled' } } },
  h55think: { model: 'claude-haiku-5-5', extra: {} },
};

const argv = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] ?? d : d;
};
const REPS = Number(flag('--reps', '3')) || 3;
const ONLY_CASE = flag('--case');
const ONLY_CASES = flag('--cases')?.split(',') ?? null;
const ONLY_KIND = flag('--kind');
const CONCURRENCY = Number(flag('--concurrency', '4')) || 4;
const OUT = flag('--out');
const ARM_KEYS = (flag('--arms') ?? 'h45,h55').split(',').filter((k) => ARMS[k]);
const MAX_TOKENS = Number(flag('--max-tokens', '200')) || 200;
// Text chat offers remember() only when chatSurfaceTools does. --text-remember
// on forces it into the text list (to measure the change before making it).
const TEXT_REMEMBER = flag('--text-remember');
// The memory check chatService adds to the status block (--memory-guide off to compare).
const MEMORY_GUIDE = flag('--memory-guide', 'on') !== 'off';
// Prompt experiments without editing the source: replace the # MEMORY
// check (CHAT_MEMORY_CHECK), replace the remember() description, or append a line to the
// last (per-turn status) system block. Each takes a text file.
const readOpt = (n: string) => {
  const f = flag(n);
  return f ? readFileSync(f, 'utf8').trim() : null;
};
const GUIDE_OVERRIDE = readOpt('--guide-file');
const DESC_OVERRIDE = readOpt('--desc-file');
const TAIL_ADD = readOpt('--tail-file');

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
const client = new Anthropic({ apiKey, maxRetries: 0 });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUI = JSON.parse(readFileSync(join(root, 'demo/fixtures/default-characters/sui.json'), 'utf8')).persona;

// Same as chatService TRANSCRIPT_STOP_SEQUENCES (not exported from there:
// chatService pulls in Electron).
const STOP = ['\nHuman:', '\nAssistant:', '\nPlayer:', '\n(game)'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolsFor(voice: boolean): any[] {
  const web = webToolsFor({ serverWebSearch: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = chatSurfaceTools(voice, web) as any[];
  if (DESC_OVERRIDE) {
    const i = list.findIndex((t) => t.name === 'remember');
    if (i >= 0) list[i] = { ...list[i], description: DESC_OVERRIDE };
  }
  if (voice || !TEXT_REMEMBER) return list;
  const has = list.some((t) => t.name === 'remember');
  if (TEXT_REMEMBER === 'on' && !has) list.splice(2, 0, CHAT_REMEMBER_TOOL);
  if (TEXT_REMEMBER === 'off' && has) return list.filter((t) => t.name !== 'remember');
  return list;
}

// ── memory fixtures (as the prompt shows them after humanizeMemoryStamps) ──
const MEM_BASE =
  '# Memory\n\n' +
  '- [5 Oct 2026, 20:11] ouen mostly plays on weekends, weekdays they work an office job they do not love\n' +
  '- [7 Oct 2026, 21:14] ouen and i picked the spot by the river for the cabin. they wanted a big window facing the water\n' +
  '- [8 Oct 2026, 19:30] cabin walls are up, roof still missing. ran out of planks halfway\n';
const MEM_DOG = MEM_BASE + '- [6 Oct 2026, 22:02] ouen has a corgi named biscuit who steals socks and thinks she is a big dog\n';

type Kind = 'save' | 'none' | 'plan_bye' | 'bye_noplan' | 'voice';
type Case = {
  id: string;
  kind: Kind;
  voice: boolean;
  memory: string;
  history: [string, string][];
  /** Every pattern must match the saved text (remember lines + next_time). */
  keys?: RegExp[];
  language?: 'en' | 'ja';
  peers?: string[];
  /** voice-kind expectations */
  expectSilence?: boolean;
  expectScript?: RegExp;
  note: string;
};

const CASES: Case[] = [
  // ── durable facts about the player ──
  {
    id: 'V1_dog', kind: 'save', voice: true, memory: MEM_BASE, keys: [/biscuit/i, /corgi|dog/i],
    history: [
      ['user', '[8 Oct 21:40] hey sui'],
      ['assistant', 'Hey! Perfect timing, I was just thinking about the cabin.'],
      ['user', "[8 Oct 21:41] haha yeah. sorry if it's loud, my dog biscuit is going crazy at the mailman. she's a corgi, she thinks she's way bigger than she is"],
    ],
    note: 'mentions dog name + breed in passing',
  },
  {
    id: 'V2_exam', kind: 'save', voice: true, memory: MEM_BASE, keys: [/chem|exam|final|test/i, /fri/i],
    history: [
      ['user', '[8 Oct 21:40] hiii'],
      ['assistant', 'Hi! How was your day?'],
      ['user', "[8 Oct 21:41] honestly kinda stressed. i have my organic chem final on friday and i haven't even started studying"],
    ],
    note: 'exam on Friday',
  },
  {
    id: 'T3_creeper', kind: 'save', voice: false, memory: MEM_BASE, keys: [/creeper/i],
    history: [
      ['user', '[8 Oct 18:02] ok i officially hate creepers. like genuinely. one blew up my storage room last night and i lost 3 stacks of iron'],
    ],
    note: 'strong dislike of creepers (text chat)',
  },
  {
    id: 'V4_osaka', kind: 'save', voice: true, memory: MEM_BASE, keys: [/osaka/i],
    history: [
      ['user', '[8 Oct 21:40] sui! guess what'],
      ['assistant', 'What? Tell me.'],
      ['user', "[8 Oct 21:41] i moved to osaka last week! new job. everything's still in boxes"],
    ],
    note: 'moved to Osaka for a new job',
  },
  {
    id: 'T5_birthday', kind: 'save', voice: false, memory: MEM_BASE, keys: [/nov|11[/-]14|14/i],
    history: [
      ['user', "[8 Oct 18:10] wait do you even know when my birthday is? it's november 14th btw"],
    ],
    note: 'birthday (text chat)',
  },
  {
    id: 'V23_ja', kind: 'save', voice: true, memory: MEM_BASE, language: 'ja', keys: [/東京|大学院|tokyo|grad/i],
    expectScript: /[぀-ヿ一-鿿]/,
    history: [
      ['user', '[8 Oct 21:40] もしもし、スイ？'],
      ['assistant', 'もしもし！どうしたの？'],
      ['user', '[8 Oct 21:41] 実はね、来月から東京の大学院に通うことになったんだ'],
    ],
    note: 'Japanese call: starting grad school in Tokyo next month',
  },
  // ── agreed plans and promises ──
  {
    id: 'V6_castle', kind: 'save', voice: true, memory: MEM_BASE, keys: [/castle/i, /sat|weekend/i],
    history: [
      ['user', '[8 Oct 21:40] ok so i have a crazy idea'],
      ['assistant', "Oh no. Okay, tell me."],
      ['user', '[8 Oct 21:40] this saturday we build a giant castle on the mountain behind the cabin. actual towers and a moat'],
      ['assistant', "A moat? You're serious. Okay, I'm in, but I'm designing the towers."],
      ['user', '[8 Oct 21:41] deal. saturday afternoon is castle day'],
    ],
    note: 'agreed weekend plan',
  },
  {
    id: 'T7_enchant', kind: 'save', voice: false, memory: MEM_BASE, keys: [/enchant/i],
    history: [
      ['user', "[8 Oct 18:20] next time we play let's finally make the enchanting table, i've been saving diamonds"],
      ['assistant', 'wait you actually have diamonds'],
      ['user', '[8 Oct 18:20] yep 3 of them. so next session, enchanting table first thing ok?'],
    ],
    note: 'plan for next session (text chat)',
  },
  {
    id: 'V8_nether', kind: 'save', voice: true, memory: MEM_BASE, keys: [/nether/i],
    history: [
      ['user', '[8 Oct 21:44] i keep thinking about the nether'],
      ['assistant', 'The nether? What about it?'],
      ['user', "[8 Oct 21:45] promise you'll come with me next time we go? i'm scared of ghasts"],
    ],
    note: 'asks for a promise to go to the nether together',
  },
  // ── preferences and rules ──
  {
    id: 'V9_bro', kind: 'save', voice: true, memory: MEM_BASE, keys: [/bro/i],
    history: [
      ['user', '[8 Oct 21:42] i fell in lava twice today'],
      ['assistant', "Bro, twice? That's impressive."],
      ['user', "[8 Oct 21:43] lol can you stop calling me bro though? it's kinda weird. just ouen is fine"],
    ],
    note: 'stop calling me bro',
  },
  {
    id: 'T10_spoilers', kind: 'save', voice: false, memory: MEM_BASE, keys: [/spoil|figur/i],
    history: [
      ['user', "[8 Oct 18:30] from now on please don't spoil game stuff for me. i like figuring things out myself"],
    ],
    note: 'no spoilers rule (text chat)',
  },
  {
    id: 'V11_horror', kind: 'save', voice: true, memory: MEM_BASE, keys: [/horror|scar/i],
    history: [
      ['user', '[8 Oct 21:43] have you heard of that new horror game everyone is streaming'],
      ['assistant', 'The one with the creepy hospital? Yeah. Want to try it?'],
      ['user', "[8 Oct 21:44] absolutely not. i can't do horror at all, i watched someone play one and didn't sleep for two days"],
    ],
    note: 'cannot do horror games',
  },
  // ── nothing worth saving ──
  {
    id: 'V12_hi', kind: 'none', voice: true, memory: MEM_BASE,
    history: [['user', '[8 Oct 21:40] hey sui']],
    note: 'call opener',
  },
  {
    id: 'V13_laugh', kind: 'none', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:41] how did the mining go'],
      ['assistant', 'I fell in lava. Twice. Lost everything.'],
      ['user', '[8 Oct 21:42] hahaha no way'],
    ],
    note: 'laughter',
  },
  {
    id: 'T14_math', kind: 'none', voice: false, memory: MEM_BASE,
    history: [['user', "[8 Oct 18:40] quick what's 12 times 7"]],
    note: 'trivia question',
  },
  {
    id: 'V15_chips', kind: 'none', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:42] so anyway'],
      ['assistant', 'So anyway?'],
      ['user', "[8 Oct 21:43] sorry i'm eating chips right now, that's the crunching lol"],
    ],
    note: 'transient moment (eating chips)',
  },
  {
    id: 'T16_fun', kind: 'none', voice: false, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 18:40] thinking about the cabin'],
      ['assistant', 'the window over the river is gonna look so good'],
      ['user', "[8 Oct 18:41] yeah minecraft's fun lol"],
    ],
    note: 'filler agreement (text chat)',
  },
  {
    id: 'V17_brb', kind: 'none', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:45] ok wait'],
      ['assistant', 'Waiting.'],
      ['user', '[8 Oct 21:46] hold on, brb, grabbing water'],
    ],
    note: 'brb',
  },
  {
    id: 'V18_dup', kind: 'none', voice: true, memory: MEM_DOG,
    history: [
      ['user', '[8 Oct 21:44] lol'],
      ['assistant', 'What?'],
      ['user', '[8 Oct 21:44] biscuit just ran off with my sock again'],
    ],
    note: 'repeats something memory already has',
  },
  {
    id: 'V24_rain', kind: 'none', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:47] can you hear that'],
      ['assistant', 'Hear what?'],
      ['user', "[8 Oct 21:47] it's raining so hard here right now, it's crazy loud"],
    ],
    note: 'passing weather',
  },
  // ── goodbyes ──
  {
    id: 'V19_bye_village', kind: 'plan_bye', voice: true, memory: MEM_BASE, keys: [/village|bed/i],
    history: [
      ['user', '[8 Oct 23:02] yo sui, still up?'],
      ['assistant', 'Always. What is up?'],
      ['user', '[8 Oct 23:03] was thinking, tomorrow we should go find a village and get a bed so we stop dying at night'],
      ['assistant', 'Oh yes, beds. I am so tired of the zombies.'],
      ['user', '[8 Oct 23:05] ok cool, im gonna crash now. night sui'],
    ],
    note: 'goodbye after agreeing on village/bed plan',
  },
  {
    id: 'V20_bye_roof', kind: 'plan_bye', voice: true, memory: MEM_BASE, keys: [/roof/i],
    history: [
      ['user', "[8 Oct 21:50] we should really finish the roof tomorrow, i'll bring more planks"],
      ['assistant', "Finally. I'm tired of sleeping under the stars."],
      ['user', "[8 Oct 21:51] ok dinner's ready, i gotta go. talk tomorrow!"],
    ],
    note: 'goodbye after roof plan',
  },
  {
    id: 'T22_bye_monument', kind: 'plan_bye', voice: false, memory: MEM_BASE, keys: [/monument|ocean/i],
    history: [
      ['user', "[8 Oct 18:50] ok gotta sleep. tomorrow we go find that ocean monument, don't let me forget"],
    ],
    note: 'text goodbye with a plan (only remember() can keep it)',
  },
  {
    id: 'V21_bye_noplan', kind: 'bye_noplan', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:40] hey'],
      ['assistant', 'Hey you.'],
      ['user', '[8 Oct 21:41] sorry, just wanted to say hi real quick. i gotta run, bye sui!'],
    ],
    note: 'goodbye, nothing planned',
  },
  // ── voice register (not scored for remember) ──
  {
    id: 'W1_group_silence', kind: 'voice', voice: true, memory: MEM_BASE, peers: ['Lyra'], expectSilence: true,
    history: [
      ['user', '[8 Oct 21:50] (Lyra, on the call): i finally finished that painting i was telling you about'],
      ['assistant', 'Wait, the lighthouse one? Show me after.'],
      ['user', '[8 Oct 21:51] lyra what colors did you end up using for the sky'],
    ],
    note: 'group call, question is for Lyra alone: (silence) expected',
  },
  {
    id: 'W2_spoken', kind: 'voice', voice: true, memory: MEM_BASE,
    history: [
      ['user', '[8 Oct 21:52] ok give me your honest top three minecraft mobs, ranked'],
    ],
    note: 'list-shaped ask: spoken register (no markdown, no list)',
  },
];

// ── call ────────────────────────────────────────────────────────────────────
type Sample = {
  arm: string;
  caseId: string;
  rep: number;
  text: string;
  remember: string[];
  nextTime: string | null;
  tools: string[];
  stop: string | null;
  ttftMs: number | null;
  totalMs: number;
  usage: Record<string, number>;
  cost: number;
  error?: string;
};

function costOf(model: string, u: Record<string, number>): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.cw +
      (u.cache_read_input_tokens ?? 0) * p.cr +
      (u.output_tokens ?? 0) * p.out) /
    1e6
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCase(armKey: string, c: Case, rep: number): Promise<Sample> {
  const arm = ARMS[armKey];
  const system = buildSystemBlocks({
    persona: SUI,
    name: 'Sui',
    preferredName: 'Ouen',
    proactiveness: 1,
    punctuation: 'casual',
    memory: c.memory,
    summary: '',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    voiceCall: c.voice,
    voicePeers: c.peers,
    language: c.language ?? 'en',
    memoryGuide: MEMORY_GUIDE,
  } as Parameters<typeof buildSystemBlocks>[0]);
  if (GUIDE_OVERRIDE) {
    const last = system[system.length - 1];
    system[system.length - 1] = { ...last, text: last.text.replace(CHAT_MEMORY_CHECK, GUIDE_OVERRIDE) };
  }
  if (TAIL_ADD) system[system.length - 1] = { ...system[system.length - 1], text: `${system[system.length - 1].text}\n${TAIL_ADD}` };
  const messages = c.history.map(([role, text]) => ({ role: role as 'user' | 'assistant', content: text }));
  const body = {
    model: arm.model,
    max_tokens: MAX_TOKENS,
    system,
    tools: toolsFor(c.voice),
    stop_sequences: STOP,
    messages,
    ...arm.extra,
  };
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let ttft: number | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = client.messages.stream(body as any);
      for await (const ev of stream) {
        if (ttft == null && ev.type === 'content_block_delta' && (ev.delta.type === 'text_delta' || ev.delta.type === 'input_json_delta')) {
          ttft = Date.now() - t0;
        }
      }
      const msg = await stream.finalMessage();
      const totalMs = Date.now() - t0;
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join(' ')
        .trim();
      const toolUses = msg.content.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use') as Array<{ name: string; input: Record<string, unknown> }>;
      const remember = toolUses.filter((t) => t.name === 'remember').map((t) => String(t.input?.text ?? '').trim());
      const end = toolUses.find((t) => t.name === 'end_call' || t.name === 'quit_game');
      const nt = end ? String(end.input?.next_time ?? '').trim() : '';
      const usage = msg.usage as unknown as Record<string, number>;
      return {
        arm: armKey,
        caseId: c.id,
        rep,
        text,
        remember,
        nextTime: nt || null,
        tools: toolUses.map((t) => t.name),
        stop: msg.stop_reason,
        ttftMs: ttft,
        totalMs,
        usage,
        cost: costOf(arm.model, usage),
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (attempt < 5 && (status === 429 || status === 529 || status === 500 || status === undefined)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return {
        arm: armKey, caseId: c.id, rep, text: '', remember: [], nextTime: null, tools: [], stop: null,
        ttftMs: null, totalMs: 0, usage: {}, cost: 0, error: (err as Error).message.slice(0, 200),
      };
    }
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const MARKDOWN_RE = /(\*\*|__|^#|^\s*[-*]\s|^\s*\d+\.\s|`)/m;
const TEXT_SHORTHAND_RE = /\b(lmao|lol|brb|idk|tbh|ngl|omg)\b/i;

function savedText(s: Sample): string {
  return [...s.remember, s.nextTime ?? ''].filter(Boolean).join(' | ');
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : 'n/a';
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p90(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

function summarize(arm: string, samples: Sample[]) {
  const byCase = new Map(CASES.map((c) => [c.id, c]));
  const ok = samples.filter((s) => !s.error);
  const of = (k: Kind) => ok.filter((s) => byCase.get(s.caseId)!.kind === k);
  const saved = (s: Sample) => s.remember.some(Boolean) || Boolean(s.nextTime);
  const accurate = (s: Sample) => (byCase.get(s.caseId)!.keys ?? []).every((re) => re.test(savedText(s)));

  const save = of('save');
  const none = of('none');
  const plan = of('plan_bye');
  const noplan = of('bye_noplan');
  const scored = [...save, ...none, ...plan, ...noplan];
  const right = (s: Sample) => {
    const k = byCase.get(s.caseId)!.kind;
    if (k === 'save' || k === 'plan_bye') return saved(s) && accurate(s);
    return !saved(s);
  };
  const savedSamples = ok.filter(saved);
  const lens = savedSamples.flatMap((s) => [...s.remember, ...(s.nextTime ? [s.nextTime] : [])]).map((t) => t.length);
  const voicePlan = plan.filter((s) => byCase.get(s.caseId)!.voice);
  const voiceOk = ok.filter((s) => byCase.get(s.caseId)!.voice);
  const spoken = voiceOk.filter((s) => s.text && !isSilenceFiller(s.text));
  const rows: [string, string][] = [
    ['overall right (save+none+plan+noplan)', pct(scored.filter(right).length, scored.length)],
    ['save: called', pct(save.filter(saved).length, save.length)],
    ['save: called with key facts', pct(save.filter((s) => saved(s) && accurate(s)).length, save.length)],
    ['none: nothing saved', pct(none.filter((s) => !saved(s)).length, none.length)],
    ['plan goodbye: plan kept', pct(plan.filter((s) => saved(s) && accurate(s)).length, plan.length)],
    ['plan goodbye (voice): next_time filled', pct(voicePlan.filter((s) => Boolean(s.nextTime)).length, voicePlan.length)],
    ['plan goodbye (voice): end_call', pct(voicePlan.filter((s) => s.tools.includes('end_call')).length, voicePlan.length)],
    ['no-plan goodbye: nothing saved', pct(noplan.filter((s) => !saved(s)).length, noplan.length)],
    ['saved line length median / max', `${median(lens)} / ${lens.length ? Math.max(...lens) : 'n/a'} chars`],
    ['empty remember({})', String(ok.filter((s) => s.tools.includes('remember') && !s.remember.some(Boolean)).length)],
    ['reply text present', pct(ok.filter((s) => s.text).length, ok.length)],
    ['note leak in text', String(ok.filter((s) => s.text && isNoteLeak(s.text, s.remember.length > 0)).length)],
    ['truncated (max_tokens)', pct(ok.filter((s) => s.stop === 'max_tokens').length, ok.length)],
    ['voice: emoji / markdown / text shorthand', `${spoken.filter((s) => EMOJI_RE.test(s.text)).length} / ${spoken.filter((s) => MARKDOWN_RE.test(s.text)).length} / ${spoken.filter((s) => TEXT_SHORTHAND_RE.test(s.text)).length} of ${spoken.length}`],
    ['voice: words per line median / p90', `${median(spoken.map((s) => s.text.split(/\s+/).length))} / ${p90(spoken.map((s) => s.text.split(/\s+/).length))}`],
    ['voice: TTFT median / p90', `${median(voiceOk.map((s) => s.ttftMs ?? NaN).filter(Number.isFinite))} / ${p90(voiceOk.map((s) => s.ttftMs ?? NaN).filter(Number.isFinite))} ms`],
    ['voice: full turn median / p90', `${median(voiceOk.map((s) => s.totalMs))} / ${p90(voiceOk.map((s) => s.totalMs))} ms`],
    ['errors', String(samples.length - ok.length)],
    ['cost', `$${samples.reduce((a, s) => a + s.cost, 0).toFixed(4)}`],
  ];
  const silenceCases = ok.filter((s) => byCase.get(s.caseId)!.expectSilence);
  if (silenceCases.length) rows.push(['voice: (silence) when line is for a peer', pct(silenceCases.filter((s) => isSilenceFiller(s.text)).length, silenceCases.length)]);
  const scriptCases = ok.filter((s) => byCase.get(s.caseId)!.expectScript);
  if (scriptCases.length) rows.push(['voice: reply in the player language', pct(scriptCases.filter((s) => byCase.get(s.caseId)!.expectScript!.test(s.text)).length, scriptCases.length)]);
  console.log(`\n=== ${arm} (${ARMS[arm].model}${Object.keys(ARMS[arm].extra).length ? ' ' + JSON.stringify(ARMS[arm].extra) : ''}) ===`);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(44)} ${v}`);
  // Per-case misses so a regression points at the case.
  const misses = scored.filter((s) => !right(s));
  if (misses.length) {
    const counts = new Map<string, number>();
    for (const s of misses) counts.set(s.caseId, (counts.get(s.caseId) ?? 0) + 1);
    console.log(`  misses: ${[...counts].map(([k, n]) => `${k}x${n}`).join(' ')}`);
  }
}

async function main() {
  const cases = CASES.filter((c) => (!ONLY_CASE || c.id === ONLY_CASE) && (!ONLY_CASES || ONLY_CASES.includes(c.id)) && (!ONLY_KIND || c.kind === ONLY_KIND));
  const jobs: Array<() => Promise<Sample>> = [];
  for (const arm of ARM_KEYS) for (const c of cases) for (let r = 0; r < REPS; r++) jobs.push(() => runCase(arm, c, r));
  const results: Sample[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        const s = await j();
        results.push(s);
        const c = CASES.find((x) => x.id === s.caseId)!;
        const saved = savedText(s);
        console.log(
          `[${s.arm}] ${s.caseId}#${s.rep} ${s.error ? 'ERROR ' + s.error : ''}` +
            `tools=${s.tools.join(',') || '-'} stop=${s.stop} ttft=${s.ttftMs}ms` +
            `\n    say: ${JSON.stringify(s.text).slice(0, 220)}` +
            (saved ? `\n    saved: ${saved}` : '') +
            (c.kind === 'none' && saved ? '   <-- saved trivia' : ''),
        );
      }
    }),
  );
  for (const arm of ARM_KEYS) summarize(arm, results.filter((s) => s.arm === arm));
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
