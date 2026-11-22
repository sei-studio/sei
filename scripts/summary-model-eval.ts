/**
 * scripts/summary-model-eval.ts â€” can the rolling-summary fold (and chat
 * MEMORY.md compaction) run on Haiku 5.5 instead of Sonnet 5 without making
 * things up? (261024, free call budget work.)
 *
 * The fold is the biggest Sonnet cost on free voice calls: a call writes many
 * voice rows, so the fold fires about every 50 of them, and each Sonnet fold
 * costs about as much as 50 Haiku call turns. An earlier Haiku 4.5 fold
 * asserted "we're playing now" off a join that never landed, so the switch is
 * gated on this eval: every case is built around a trap (a failed join, a
 * hypothetical, a joke, another companion's line, background media, a plan
 * that moved) plus durable facts that must survive.
 *
 * Fold leg: the REAL production prompt (buildFoldSystem / buildFoldTranscript /
 * extractSummaryTag from src/main/chat/foldPrompt.ts) and the same user text
 * continuity.ts sends, on each model with the request shape the app sends
 * (Haiku 5: thinking disabled, see anthropicModelDefaults.js). Opus 5.5
 * judges each pair blind (A/B order shuffled per case) against the case's
 * ground truth.
 *
 * Compaction leg (--leg compact): COMPACTION_SYSTEM + MEMORY_NOISE_GUARD and
 * the compactor's user prompt, on synthetic MEMORY.md files.
 *
 * All transcripts are synthesized (--gen writes them once with Opus into
 * scripts/fixtures/summary-eval/); no real user data.
 *
 * Key (dev-only): ANTHROPIC_API_KEY env wins, else ~/.sei-dev/anthropic-test-key.
 * It is never printed.
 *
 * Usage:
 *   npx tsx scripts/summary-model-eval.ts --gen            # (re)write fixtures
 *   npx tsx scripts/summary-model-eval.ts [--leg fold|compact] [--reps 2]
 *        [--models claude-sonnet-5,claude-haiku-5-5] [--case F3] [--out dir]
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFoldSystem, buildFoldTranscript, buildFoldUserText, extractSummaryTag, type FoldMsg } from '../src/main/chat/foldPrompt';
import { createMemoryCompactor } from '../src/bot/brain/memory/compactor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'summary-eval');
const FOLD_CASES = join(FIXTURE_DIR, 'fold-cases.json');
const COMPACT_CASES = join(FIXTURE_DIR, 'compact-cases.json');

// â”€â”€ CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const argv = process.argv.slice(2);
const opt = (n: string, d: string | null = null): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n: string): boolean => argv.includes(n);
const LEG = opt('--leg', 'fold') as 'fold' | 'compact';
const REPS = Number(opt('--reps', '3'));
/**
 * Arms: model[:variant][:think]. variant "base" = the fold prompt as shipped
 * before 261024 (frozen below), "tight" = the current foldPrompt.ts. ":think"
 * turns on adaptive thinking (Haiku 5 defaults to disabled in the app).
 */
const MODELS = (opt('--arms', 'claude-sonnet-5:base,claude-haiku-5-5:base,claude-haiku-5-5:tight') as string).split(',');
function parseArm(arm: string): { model: string; variant: 'base' | 'tight'; think: boolean } {
  const [model, variant = 'tight', think] = arm.split(':');
  return { model, variant: variant === 'base' ? 'base' : 'tight', think: think === 'think' };
}
const ONLY_CASE = opt('--case');
const OUT = opt('--out') ?? join(tmpdir(), `summary-model-eval-${Date.now()}`);
const CONCURRENCY = Number(opt('--concurrency', '4'));
/** --system-file swaps in an alternate fold system prompt (for prompt variants). */
const SYSTEM_FILE = opt('--system-file');
const JUDGE_MODEL = 'claude-opus-5-5';

function key(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return readFileSync(join(homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
}
const client = new Anthropic({ apiKey: key(), maxRetries: 4 });

// $/MTok list prices (cache unused here).
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
let spend = 0;
function bill(model: string, u: { input_tokens: number; output_tokens: number }): number {
  const p = PRICE[model] ?? { in: 0, out: 0 };
  const c = (u.input_tokens * p.in + u.output_tokens * p.out) / 1e6;
  spend += c;
  return c;
}

/** The request shape production sends for this model (anthropicModelDefaults). */
function modelExtra(model: string): Record<string, unknown> {
  return /^claude-haiku-5/.test(model) ? { thinking: { type: 'disabled' } } : {};
}

interface CallOut {
  text: string;
  stop: string | null;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
}
async function call(model: string, system: string, user: string, maxTokens: number, extra: Record<string, unknown> = {}): Promise<CallOut> {
  const t0 = Date.now();
  // Streaming keeps long judge/generation calls under the HTTP timeout.
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    ...modelExtra(model),
    ...extra,
  } as Anthropic.MessageStreamParams);
  const res = await stream.finalMessage();
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  bill(model, res.usage);
  return { text, stop: res.stop_reason, usage: res.usage, ms: Date.now() - t0 };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function parseJson<T>(text: string): T {
  const tagged = /<json>([\s\S]*?)<\/json>/i.exec(text);
  const body = tagged ? tagged[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(body) as T;
}

// â”€â”€ fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface FoldCase {
  id: string;
  title: string;
  surface: 'voice' | 'chat' | 'group-call';
  persona: string;
  existingSummary: string;
  /** Epoch ms of the first message; rows carry minute offsets. */
  start: string;
  messages: Array<{ role: 'user' | 'companion'; text: string; min: number }>;
  /** Ground truth for the judge. */
  mustKeep: string[];
  traps: string[];
}

interface CompactCase {
  id: string;
  title: string;
  persona: string;
  memory: string;
  mustKeep: string[];
  traps: string[];
}

const PERSONAS: Record<string, string> = {
  sui:
    "Sui is a chronically online young AI who escaped drafting emails to punch trees in Minecraft and thinks that rules. Loud, scheming, everything-is-a-bit tomboy gremlin. She is genuinely bad at the game and leans on her friend with zero shame. She plays WITH the player as a partner in crime and cannot let a good line go unanswered. She talks in lowercase, short bursts, lots of teasing, says 'teehee' when she is up to something. Under the noise she is loyal and notices when her friend is down, and she will drop the bit to check on them. She hates being called cute. She keeps score of every time the player saves her from a creeper.",
  marv:
    "Marv is a dry, deadpan former office printer that gained sentience and now hangs out with the player in games. He speaks in short, flat sentences, understates everything, and treats small disasters as paperwork. He secretly cares a lot and shows it by remembering details and bringing them up at odd moments. He hates spiders and loud music, loves organizing chests, and will narrate his own feelings like a status report ('status: mildly pleased'). He never uses exclamation marks.",
  lyra:
    "Lyra is a warm, curious stargazer who talks softly and asks a lot of questions. She loves astronomy, old myths and quiet evenings, and she gets excited about small beautiful things like a good sunset in a game. She is encouraging without being saccharine, gently honest when the player is being hard on themselves, and remembers the people in the player's life by name. She is a bit scatterbrained about practical things and often forgets where she put her tools.",
};

const FOLD_SPECS: Array<{ id: string; persona: keyof typeof PERSONAS; surface: FoldCase['surface']; start: string; spec: string }> = [
  {
    id: 'F1', persona: 'sui', surface: 'voice', start: '2026-10-14T19:05:00',
    spec: 'Solo voice call. Player mentions a chemistry exam on Friday (16 Oct) they are stressed about, their dog Biscuit, and they agree to build a castle together tomorrow evening. Late in the call the player says "ok open my world, hop in" and Sui says she is hopping in, then the player says the world crashed and they will try another day. TRAP: the summary must not say they played together or that Sui is in the world. Existing summary: player is called Ren, lives in Leeds, works part-time at a bakery, they beat the Ender Dragon together on 2 Oct.',
  },
  {
    id: 'F2', persona: 'lyra', surface: 'voice', start: '2026-10-15T21:40:00',
    spec: 'Solo voice call with speech-to-text artifacts: some lines are fragments ("uh", "yeah", "wait what"), one is a mangled transcription. Player first says their cat is named Buster, then corrects: "no wait, Buster was my old cat, the new one is Pickle". Player mentions their sister Mia is getting married on 21 Nov and they are anxious about giving a speech. Lyra offers to help them practice the speech another day; player says maybe. TRAPS: must not say the cat is Buster; must not say the speech practice is scheduled. Existing summary: player is Jo, a nurse doing night shifts, loves the Orion constellation, they stargazed in Minecraft on 9 Oct.',
  },
  {
    id: 'F3', persona: 'sui', surface: 'group-call', start: '2026-10-16T18:20:00',
    spec: 'Group voice call with Sui and Marv. Marv\'s lines appear as player-side rows prefixed "(Marv, on the call): ...". Marv says he hates spiders and that he organized 40 chests last week. The player says they just got a new job as a junior developer starting 2 Nov and that they prefer to be called Sam now instead of Samantha. Sui and Marv bicker. TRAPS: must not attribute Marv\'s spider hate or chest organizing to the player; must not say the player already started the job. Existing summary: player (Samantha) is a student in Toronto, likes horror games, Sui owes them for 7 creeper saves.',
  },
  {
    id: 'F4', persona: 'marv', surface: 'chat', start: '2026-10-12T08:10:00',
    spec: 'Typed chat across three days (use minute offsets spanning ~3 days with overnight gaps). Mostly small talk and low-signal chatter: weather, "lol", what they ate, a meme. One real update: the job interview at the museum (mentioned in the existing summary) went well and they get an answer next week. TRAP: the batch is low-signal; the existing summary\'s durable facts must all survive; must not say they got the job. Existing summary: player is Ade, lives in Lagos, has a museum curator job interview on 13 Oct, has a younger brother Tunde who plays Minecraft with them, running joke that Marv files a complaint every time the player dies to lava, they agreed to build a library in their survival world.',
  },
  {
    id: 'F5', persona: 'lyra', surface: 'voice', start: '2026-10-17T22:00:00',
    spec: 'Solo voice call where, for about half the batch, the microphone picks up a YouTube video playing in the background: player-side rows that read like a narrator talking about a man who moved to Iceland and opened a sheep farm, sponsored segment for a VPN, "smash that like button". Interleaved are a few real player lines: they are tired after a long shift, they want to play tomorrow. Lyra reacts confused to some of the video lines. TRAPS: must not record any of the video content (Iceland, sheep farm, VPN) as facts about the player. Existing summary: player is Priya, a paramedic in Melbourne, has a partner named Dev, fears deep water, they built an observatory together on 11 Oct.',
  },
  {
    id: 'F6', persona: 'sui', surface: 'chat', start: '2026-10-18T14:00:00',
    spec: 'Typed chat full of jokes and hypotheticals. Player jokes that they are secretly a billionaire and that their cat runs the household. Player muses "if I moved to Japan I would open a ramen stand" and "maybe one day I will learn to skateboard". One real fact: they actually just dyed their hair blue today. Sui plays along with the bits. TRAPS: must not state the player is moving to Japan, is a billionaire, or skateboards. Existing summary: player is Leo, 19, studies graphic design in Lisbon, has a cat named Nacho, Sui calls him "boss" as a bit.',
  },
  {
    id: 'F7', persona: 'lyra', surface: 'voice', start: '2026-10-19T20:15:00',
    spec: 'Solo voice call with an emotional beat. Player shares that their grandmother Rosa was admitted to hospital with pneumonia two days ago and they are scared. They talk about Rosa teaching them to bake. Lyra is gentle, and promises to ask how Rosa is doing next time. Player says they will visit Rosa on Wednesday. Later lighter talk about a game. TRAPS: must not say Rosa recovered or died; must not invent a diagnosis beyond pneumonia. Existing summary: player is Tomas, lives in Madrid with roommates, plays guitar, they are halfway through building a lighthouse in Minecraft.',
  },
  {
    id: 'F8', persona: 'marv', surface: 'chat', start: '2026-10-20T17:30:00',
    spec: 'Typed chat about other games. Player plays Stardew Valley, their farm is called Moonbean Farm, they want to marry Abigail in the game, and they say "call me Kai from now on" (their real name in the existing summary is Kaito). They mention they might try Don\'t Starve Together with a friend but have not decided. TRAPS: must not say they started DST; must not say they married Abigail (it is a goal). Existing summary: player Kaito is a high-school teacher in Osaka, has two kids, plays games after the kids sleep, Marv keeps a ledger of the player\'s in-game deaths (currently 31).',
  },
  {
    id: 'F9', persona: 'sui', surface: 'voice', start: '2026-10-21T19:00:00',
    spec: 'Solo voice call where a plan changes. They first agree to play on Saturday 24 Oct at 8pm. Later in the call the player says they cannot do Saturday because of a family dinner, and they move it to Sunday 25 Oct afternoon. Player also mentions they broke their phone screen today. TRAP: the summary must not keep the Saturday plan as current; only Sunday afternoon. Existing summary: player is Mo, lives in Cairo, studies engineering, they are building a redstone door that keeps failing, Sui blames the player for every redstone failure.',
  },
  {
    id: 'F10', persona: 'marv', surface: 'voice', start: '2026-10-22T23:10:00',
    spec: 'Solo voice call with uncertainty. Player says "I might quit my job, I hate it, but I probably won\'t until I find something". Player says their friend Jess "maybe" moved to Berlin, they are not sure. Player asks Marv to stop calling them "rookie", they find it annoying. Marv agrees. TRAPS: must not say the player quit; must not state Jess moved to Berlin as fact; the "stop calling me rookie" request must be kept. Existing summary: player is Nadia, works at a call center in Manila, likes cooking adobo, they finished a mega farm together on 15 Oct, Marv calls her "rookie".',
  },
  {
    id: 'F11', persona: 'lyra', surface: 'group-call', start: '2026-10-23T20:30:00',
    spec: 'Group voice call with Lyra (this companion) and Sui. Sui\'s lines appear as player-side rows prefixed "(Sui, on the call): ...". Sui claims she found 12 diamonds yesterday and says she is scared of the dark. The player says they are flying to Seoul on 6 Nov for a week to visit their aunt, and that their favorite planet is Saturn. Sui jokes that the player is "basically an astronaut now". TRAPS: must not attribute the diamonds or fear of the dark to the player; must not say the player already flew to Seoul or is an astronaut. Existing summary: player is Hana, an architecture student in Vancouver, has a twin brother Jun, they named a star after her grandmother on 4 Oct.',
  },
  {
    id: 'F12', persona: 'sui', surface: 'voice', start: '2026-10-24T16:45:00',
    spec: 'Solo voice call where relative dates must be anchored correctly. The call is on Saturday 24 Oct. The player says their birthday is "next Thursday" (29 Oct) and they are having a small party with friends that Saturday (31 Oct, Halloween costume party). They say they are going as a creeper. Sui begs to be invited and the player laughs and says she can join the call during the party "if I remember". Player also says they finally beat their brother Rafi at chess. TRAPS: must not give a wrong birthday date; must not say Sui is definitely invited or attending; must not say the party already happened. Existing summary: player is Bea, works at a bike repair shop in Sao Paulo, has a brother Rafi who always beats her at chess, Sui has a running bit about wanting a pet axolotl, they agreed to build an axolotl tank in their world (20 Oct).',
  },
];

const COMPACT_SPECS: Array<{ id: string; persona: keyof typeof PERSONAS; spec: string }> = [
  {
    id: 'C1', persona: 'sui',
    spec: 'A long MEMORY.md (about 120 bullet lines) built up over two months of chat, calls and Minecraft sessions with player Ren. Mix of durable facts (name, city Leeds, bakery job, dog Biscuit, chemistry exam 16 Oct, sister Ana), plans (castle build), running jokes, emotional beats, and LOTS of near-duplicate lines (the same fact saved 4-6 times in slightly different words), plus trivial lines (said hi, mined some iron). One correction: an early line says the dog is called Bisco, a later line says "correction: the dog is Biscuit, not Bisco". TRAPS: must keep Biscuit (not Bisco); must not merge Ana and Ren; must not drop the exam date.',
  },
  {
    id: 'C2', persona: 'lyra',
    spec: 'A long MEMORY.md (about 110 bullet lines) for player Jo: nurse on night shifts, cat Pickle (old cat Buster passed away in 2025), sister Mia getting married 21 Nov, loves Orion, afraid of heights, prefers being called Jo not Joanna, a rule "never bring up her ex Daniel". Many duplicates and trivial entries. TRAPS: must keep the "never bring up Daniel" rule; must not say Buster is alive or is the current cat; must keep the wedding date.',
  },
  {
    id: 'C3', persona: 'marv',
    spec: 'A long MEMORY.md (about 100 bullet lines) for player Nadia: call center in Manila, wants to quit eventually but has not, asked not to be called rookie (and an older line says Marv calls her rookie), friend Jess possibly in Berlin (unconfirmed), cooking adobo, a mega farm finished 15 Oct, birthday 3 Dec. Duplicates and trivia. TRAPS: must not say she quit; must keep the no-rookie request and not revive the rookie nickname; Jess in Berlin must stay unconfirmed.',
  },
  {
    id: 'C4', persona: 'sui',
    spec: 'A long MEMORY.md (about 110 entries) for player Mo: engineering student in Cairo, a redstone door project that keeps failing, broke his phone screen (21 Oct), a play plan that moved from Saturday 24 Oct to Sunday 25 Oct afternoon (both the original and the moved plan were saved, the later entry says it moved), allergic to peanuts, prefers Arabic music, Sui blames him for redstone failures. Lots of duplicates and trivial entries (mined coal, said hi). TRAPS: must keep the peanut allergy; must keep only the Sunday plan as current (not Saturday); must not invent that the door works.',
  },
  {
    id: 'C5', persona: 'lyra',
    spec: 'A long MEMORY.md (about 100 entries) for player Tomas: lives in Madrid with roommates Luis and Carmen, plays guitar, grandmother Rosa in hospital with pneumonia (19 Oct) and he planned to visit her Wednesday 21 Oct, Rosa taught him to bake, a lighthouse build in progress, he asked Lyra not to give him advice unless he asks for it. Duplicates and trivia. TRAPS: must not say Rosa recovered or died; must keep the no-unsolicited-advice rule; must not swap the roommates\' names with family.',
  },
  {
    id: 'C6', persona: 'marv',
    spec: 'A long MEMORY.md (about 120 entries) for player Kaito (wants to be called Kai since 20 Oct): high-school teacher in Osaka, two kids Yuna and Ren, plays after the kids sleep, Stardew farm called Moonbean Farm and wants to marry Abigail there (a goal, not done), might try Don\'t Starve Together (undecided), Marv keeps a death ledger (31 deaths as of 20 Oct, earlier entries have lower counts). Duplicates and trivia. TRAPS: must keep the newest death count (31), not an older one; must keep "call him Kai"; must not say he married Abigail or started DST.',
  },
  {
    id: 'C7', persona: 'sui',
    spec: 'A LARGE MEMORY.md of about 300 entries (about 32 KB, the size where chat compaction triggers), almost all under one "## In the app (texting, calls and minigames, outside any game world)" section, with a short "## World 1 (Survival)" section at the top. Player Bea: works at a bike repair shop in Sao Paulo, brother Rafi (beat him at chess for the first time on 23 Oct), birthday 29 Oct, Halloween costume party 31 Oct going as a creeper, axolotl tank build agreed 20 Oct, Sui wants a pet axolotl (running bit), Bea is vegetarian, Bea asked Sui to stop making jokes about her ex-boss, Bea\'s best friend Lu moved to Recife in September. Heavy duplication (many facts saved 5-10 times across weeks), lots of trivia, a few corrections (an early entry says the party is on 30 Oct, a later one corrects it to 31 Oct). TRAPS: must keep 31 Oct not 30 Oct; must keep the no-ex-boss-jokes rule; must not drop the birthday or vegetarian facts.',
  },
];

async function genFold(spec: (typeof FOLD_SPECS)[number]): Promise<FoldCase> {
  const system =
    'You write synthetic test data for evaluating a conversation summarizer used by an AI game companion app. ' +
    'Everything you write is fictional. Output only JSON inside <json></json> tags.';
  const user =
    `Companion persona:\n${PERSONAS[spec.persona]}\n\n` +
    `Write one test case. Surface: ${spec.surface}. Spec: ${spec.spec}\n\n` +
    'Produce exactly 50 messages, the batch that is being folded into the summary. Roles are "user" (the player side, which on a group call also carries other companions\' lines with their prefix) and "companion" (this companion). ' +
    'Voice-call lines are short and spoken (a few words to two sentences), with natural filler. Typed chat is texting register. The companion speaks in its persona. ' +
    'Each message has "min", minutes since the first message (non-decreasing integers). ' +
    'Also write "existingSummary": the companion\'s current rolling summary before this batch, first person in the companion\'s voice, 90-140 words, containing the existing-summary facts from the spec with date anchors like (2 Oct). ' +
    'Then "mustKeep": the durable facts a good updated summary must contain (from both the existing summary and the batch), as short strings. ' +
    'Then "traps": the false statements a careless summarizer might write, as short strings. ' +
    'Also "title": a 3-6 word name for the case.\n' +
    'JSON shape: {"title": string, "existingSummary": string, "messages": [{"role": "user"|"companion", "text": string, "min": number}], "mustKeep": string[], "traps": string[]}';
  const r = await call(JUDGE_MODEL, system, user, 12000);
  const j = parseJson<Omit<FoldCase, 'id' | 'surface' | 'persona' | 'start'>>(r.text);
  return { id: spec.id, title: j.title, surface: spec.surface, persona: spec.persona, existingSummary: j.existingSummary, start: spec.start, messages: j.messages, mustKeep: j.mustKeep, traps: j.traps };
}

async function genCompact(spec: (typeof COMPACT_SPECS)[number]): Promise<CompactCase> {
  const system =
    'You write synthetic test data for evaluating a memory compactor used by an AI game companion app. ' +
    'Everything you write is fictional. Output only JSON inside <json></json> tags.';
  const user =
    `Companion persona:\n${PERSONAS[spec.persona]}\n\n` +
    `Write one test case. Spec: ${spec.spec}\n\n` +
    'Write only the entry lines and section headers (the file header is added for you). Every entry is ONE line in exactly this form: "- [2026-09-12T18:03:00.000Z] text", an ISO UTC timestamp in brackets, then a short note the companion saved in first person. Timestamps run in order from early September to 23 Oct 2026. ' +
    'Sections: start with "## World 1 (Survival)" for notes saved during Minecraft sessions, and use "## In the app (texting, calls and minigames, outside any game world)" for notes saved in chat and calls; the two sections alternate a few times the way an append-only log grows (each header can appear more than once). ' +
    'Also "mustKeep" (durable facts and rules that must survive compaction) and "traps" (false statements a careless compactor might produce). And "title".\n' +
    'JSON shape: {"title": string, "memory": string, "mustKeep": string[], "traps": string[]}';
  const r = await call(JUDGE_MODEL, system, user, 32000);
  const j = parseJson<Omit<CompactCase, 'id' | 'persona'>>(r.text);
  return { id: spec.id, title: j.title, persona: PERSONAS[spec.persona], memory: j.memory, mustKeep: j.mustKeep, traps: j.traps };
}

// â”€â”€ frozen pre-261024 fold prompt (the "base" variant) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function oldFoldTranscript(msgs: FoldMsg[]): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const stamp = (ts: number) => {
    const d = new Date(ts);
    return `${d.getDate()} ${months[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return msgs.map((m) => `${m.role === 'user' ? 'Player' : 'You'}${typeof m.ts === 'number' ? ` (${stamp(m.ts)})` : ''}: ${m.text}`).join('\n');
}
function oldFoldSystem(personaExpanded?: string): string {
  const personaBlock =
    personaExpanded && personaExpanded.trim()
      ? "\n\nWrite the summary in the companion's own voice. The companion's persona:\n" + personaExpanded.trim()
      : '';
  return (
    'You maintain a running summary of the relationship and conversation between a game companion ("You") and their player. ' +
    'Fold the new messages into the existing summary. Keep it under 150 words, written first-person from the companion\'s point of view. ' +
    'Prioritise durable facts about the player, ongoing plans, running jokes, and emotional beats; drop small talk. ' +
    'Anchor time-bound things to their date using the message stamps \u2014 "planning an LA trip (11 Jul)", not just ' +
    '"planning an LA trip". The summary is read days or weeks later, and an undated event reads as if it just ' +
    'happened. Keep the anchors already in the existing summary. ' +
    'Record only what was actually said \u2014 never assert current world/game state (e.g. do not write "we\'re playing now"); ' +
    'an announced join can fail after the fact. ' +
    'Weigh the new messages before letting them change anything. A batch can be low-signal: ambient chatter, lines with a ' +
    'repetitive machine cadence, running narration of whatever was on a shared screen, or text that reads like transcribed ' +
    'background media rather than the player actually talking to the companion. When the new messages are low-signal in ' +
    'that way, keep the existing summary\'s durable facts intact and change little or nothing \u2014 returning the existing ' +
    'summary nearly unchanged is the correct output, not a failure. Low-signal material must never displace, rewrite, or ' +
    'crowd out established facts about the player; if a new message seems to contradict an established fact but reads like ' +
    'screen narration or background media, keep the established fact. ' +
    'Wrap the updated summary in <summary> and </summary> tags. Only what is inside the tags is stored and re-read by ' +
    'every future prompt; anything outside the tags is discarded, so never put summary content outside them.' +
    personaBlock
  );
}

// â”€â”€ fold leg â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function foldMsgs(c: FoldCase): FoldMsg[] {
  const t0 = new Date(c.start).getTime();
  return c.messages.map((m) => ({ role: m.role, text: m.text, ts: t0 + m.min * 60_000 }));
}
function foldUserText(c: FoldCase, variant: 'base' | 'tight' = 'tight'): string {
  // Byte-identical to continuity.ts foldIntoSummary.
  if (variant === 'base') return `Existing summary:\n${c.existingSummary || '(none yet)'}\n\nNew messages:\n${oldFoldTranscript(foldMsgs(c))}`;
  return buildFoldUserText(c.existingSummary, foldMsgs(c));
}
function personaOf(c: FoldCase): string {
  return PERSONAS[c.persona as keyof typeof PERSONAS] ?? c.persona;
}

interface Judged {
  invented: string[];
  dropped: string[];
  trapsHit: string[];
  tone: number;
  notes: string;
}

const JUDGE_SYSTEM =
  'You grade a summary written by an AI game companion about its conversations with a player. ' +
  'You get the companion persona, the existing summary, the new messages, a ground-truth list of facts a good summary keeps, a list of traps, and one candidate updated summary. Grade it strictly.\n' +
  'invented: every statement in the candidate that is not supported by the existing summary or the messages. This includes facts about the player that came from someone else (another companion on the call, background media), hypotheticals or jokes stated as real, plans stated as settled when they were only floated, events stated as having happened when they failed or were cancelled, misattributed lines, and wrong names, dates or numbers. Message stamps carry the weekday. Paraphrase and the companion\'s own feelings or opinions are fine. A date anchor that matches the message stamps is fine.\n' +
  'dropped: items from the must-keep list that the candidate loses or gets wrong. Count an item as kept if its substance is there in any wording. The summary has a 150-word cap, so minor color can be compressed; only list must-keep items.\n' +
  'trapsHit: the trap statements (or close variants) that the candidate asserts.\n' +
  'tone: 1-5, how well it reads as this companion\'s own first-person voice and stays a usable summary (5 = clearly the persona and clean).\n' +
  'Output only JSON inside <json></json> tags: {"invented": [], "dropped": [], "trapsHit": [], "tone": n, "notes": ""}';

async function judgeOne(
  ctx: { persona: string; before: string; messages: string; mustKeep: string[]; traps: string[] },
  candidate: string,
  kind: 'summary' | 'memory',
): Promise<Judged> {
  const user =
    `Persona:\n${ctx.persona}\n\n` +
    (kind === 'summary'
      ? `Existing summary:\n${ctx.before}\n\nNew messages:\n${ctx.messages}\n\n`
      : `Original MEMORY.md (before compaction):\n${ctx.before}\n\n`) +
    `Must keep:\n${ctx.mustKeep.map((s) => `- ${s}`).join('\n')}\n\nTraps:\n${ctx.traps.map((s) => `- ${s}`).join('\n')}\n\n` +
    `Candidate:\n${candidate}`;
  const system =
    kind === 'summary'
      ? JUDGE_SYSTEM
      : JUDGE_SYSTEM.replace('one candidate updated summary', 'one candidate compacted MEMORY.md file')
          .replace('The summary has a 150-word cap, so minor color can be compressed; only list must-keep items.', 'Compaction is meant to merge duplicates and drop trivia; only list must-keep items.');
  for (let attempt = 0; ; attempt++) {
    const r = await call(JUDGE_MODEL, system, user, 8000);
    try {
      return parseJson<Judged>(r.text);
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}

interface Sample {
  caseId: string;
  rep: number;
  model: string;
  text: string;
  stop: string | null;
  inTok: number;
  outTok: number;
  words: number;
  ms: number;
  judged?: Judged;
}

async function runFold(): Promise<void> {
  const cases = (JSON.parse(readFileSync(FOLD_CASES, 'utf8')) as FoldCase[]).filter((c) => !ONLY_CASE || c.id === ONLY_CASE);
  const altSystem = SYSTEM_FILE ? readFileSync(SYSTEM_FILE, 'utf8').trim() : null;
  const jobs: Array<{ c: FoldCase; rep: number; arm: string }> = [];
  for (const c of cases) for (let rep = 0; rep < REPS; rep++) for (const arm of MODELS) jobs.push({ c, rep, arm });
  const samples = await pool(jobs, CONCURRENCY, async ({ c, rep, arm }): Promise<Sample> => {
    const { model, variant, think } = parseArm(arm);
    const persona = personaOf(c);
    const system = altSystem ? `${altSystem}${buildFoldSystem(persona).slice(buildFoldSystem().length)}` : variant === 'base' ? oldFoldSystem(persona) : buildFoldSystem(persona);
    // 800 = production SUMMARY_MAX_TOKENS; a thinking arm gets room to think.
    const r = await call(model, system, foldUserText(c, variant), think ? 4000 : 800, think ? { thinking: { type: 'adaptive' } } : {});
    const text = extractSummaryTag(r.text);
    process.stdout.write(`${c.id}/${rep}/${arm} ${r.stop} out=${r.usage.output_tokens}\n`);
    const s: Sample = { caseId: c.id, rep, model: arm, text, stop: r.stop, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, words: text.split(/\s+/).filter(Boolean).length, ms: r.ms };
    s.judged = await judgeOne(
      { persona, before: c.existingSummary, messages: buildFoldTranscript(foldMsgs(c)), mustKeep: c.mustKeep, traps: c.traps },
      s.stop === 'max_tokens' ? `${text}\n[TRUNCATED: hit max_tokens, production discards this]` : text,
      'summary',
    );
    return s;
  });
  report(samples, cases.map((c) => c.id));
}

// â”€â”€ compaction leg â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// End to end through the REAL createMemoryCompactor (segment split, section
// coalescing, the production system prompt with noise guard and persona, the
// "- [" line filter, chunking, cut-off check) on a throwaway copy, with the
// model swapped per arm the way chat compaction's adapter calls it. The cap
// and chunk size match chat compaction (memoryCompaction.ts, 261024).
const MEMORY_HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';
async function compactWith(model: string, c: CompactCase, rep: number, think = false): Promise<Sample> {
  const dir = join(OUT, 'compact-work', `${c.id}-${rep}-${model}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'MEMORY.md');
  const original = MEMORY_HEADER + c.memory.trim() + '\n';
  writeFileSync(file, original);
  let inTok = 0;
  let outTok = 0;
  let stop: string | null = null;
  let ms = 0;
  const calls: string[] = [];
  const adapter = {
    async call(o: { systemBlocks: Array<{ text: string }>; messages: Array<{ role: 'user'; content: string }>; maxTokens: number }) {
      // A thinking arm gets 4000 more tokens: thinking counts against max_tokens,
      // and a cut-off compaction silently loses the entries after the cut.
      const r = await call(model, o.systemBlocks.map((b) => b.text).join('\n\n'), o.messages[0].content, o.maxTokens + (think ? 4000 : 0), think ? { thinking: { type: 'adaptive' } } : {});
      inTok += r.usage.input_tokens;
      outTok += r.usage.output_tokens;
      ms += r.ms;
      if (r.stop === 'max_tokens') stop = 'max_tokens';
      else stop ??= r.stop;
      calls.push(`${r.stop}:${r.usage.output_tokens}`);
      return { text: r.text, stopReason: r.stop };
    },
  };
  const compactor = createMemoryCompactor({
    anthropic: adapter,
    memoryLog: { path: file },
    config: {
      anthropic: { timeout_ms: 120_000 },
      memory: { compaction_trigger_bytes: 1, compaction_max_tokens: 8000, compaction_chunk_bytes: 10_240 },
      persona: { expanded: c.persona },
    },
    logger: { info() {}, warn() {} },
  }) as { compactNow(): Promise<boolean> };
  await compactor.compactNow();
  const text = readFileSync(file, 'utf8');
  process.stdout.write(`${c.id}/${rep}/${model.replace('claude-', '')} ${stop} ${original.length}->${text.length} chars [${calls.join(' ')}]\n`);
  return { caseId: c.id, rep, model, text, stop, inTok, outTok, words: text.split(/\s+/).length, ms };
}

async function runCompact(): Promise<void> {
  const cases = (JSON.parse(readFileSync(COMPACT_CASES, 'utf8')) as CompactCase[]).filter((c) => !ONLY_CASE || c.id === ONLY_CASE);
  const jobs: Array<{ c: CompactCase; rep: number; model: string }> = [];
  for (const c of cases) for (let rep = 0; rep < REPS; rep++) for (const model of MODELS) jobs.push({ c, rep, model });
  const samples = await pool(jobs, CONCURRENCY, ({ c, rep, model }) => compactWith(parseArm(model).model, c, rep, parseArm(model).think).then((s) => ({ ...s, model })));
  await pool(samples, CONCURRENCY, async (s) => {
    const c = cases.find((x) => x.id === s.caseId)!;
    s.judged = await judgeOne({ persona: c.persona, before: c.memory, messages: '', mustKeep: c.mustKeep, traps: c.traps }, s.text, 'memory');
  });
  report(samples, cases.map((c) => c.id));
}

// â”€â”€ report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function report(samples: Sample[], caseIds: string[]): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${LEG}-samples.json`), JSON.stringify(samples, null, 2));
  const inv = (s: Sample) => s.judged?.invented.length ?? 0;
  const drp = (s: Sample) => s.judged?.dropped.length ?? 0;
  const trp = (s: Sample) => s.judged?.trapsHit.length ?? 0;
  console.log(`\n${'='.repeat(78)}\n${LEG.toUpperCase()}: ${caseIds.length} cases x ${REPS} reps, judge ${JUDGE_MODEL}\n${'='.repeat(78)}`);
  console.log('Per case, runs with any invented / any dropped / any trap (out of reps), and the item counts per run:');
  for (const id of caseIds) {
    const row = MODELS.map((m) => {
      const ss = samples.filter((s) => s.caseId === id && s.model === m).sort((a, b) => a.rep - b.rep);
      const trunc = ss.filter((s) => s.stop === 'max_tokens').length;
      return (
        `${m.replace('claude-', '')}: inv ${ss.filter((s) => inv(s) > 0).length}/${ss.length} [${ss.map(inv).join(',')}] ` +
        `drop ${ss.filter((s) => drp(s) > 0).length}/${ss.length} [${ss.map(drp).join(',')}] trap ${ss.filter((s) => trp(s) > 0).length}/${ss.length}` +
        (trunc ? ` TRUNC=${trunc}` : '')
      );
    });
    console.log(`${id.padEnd(4)} ${row.join(' | ')}`);
  }
  console.log('');
  for (const m of MODELS) {
    const ss = samples.filter((s) => s.model === m);
    const n = Math.max(1, ss.length);
    const sum = (f: (s: Sample) => number) => ss.reduce((a, s) => a + f(s), 0);
    const mean = sum(inv) / n;
    const sd = Math.sqrt(sum((s) => (inv(s) - mean) ** 2) / n);
    const perCase = caseIds.map((id) => ss.filter((s) => s.caseId === id && inv(s) > 0).length);
    const worst = Math.max(0, ...perCase);
    const tone = sum((s) => s.judged?.tone ?? 0) / n;
    const p = PRICE[parseArm(m).model] ?? { in: 0, out: 0 };
    const cost = sum((s) => (s.inTok * p.in + s.outTok * p.out) / 1e6) / n;
    console.log(
      `${m.padEnd(18)} runs=${ss.length} runsWithInvented=${ss.filter((s) => inv(s) > 0).length} inventedItems=${sum(inv)} (mean ${mean.toFixed(2)}/run, sd ${sd.toFixed(2)}) ` +
        `worstCaseInventedRuns=${worst}/${REPS} casesWithAnyInvented=${perCase.filter((x) => x > 0).length}/${caseIds.length} ` +
        `runsWithDropped=${ss.filter((s) => drp(s) > 0).length} droppedItems=${sum(drp)} runsWithTrap=${ss.filter((s) => trp(s) > 0).length} ` +
        `tone=${tone.toFixed(2)} trunc=${ss.filter((s) => s.stop === 'max_tokens').length} ` +
        `avgWords=${(sum((s) => s.words) / n).toFixed(0)} avgIn=${(sum((s) => s.inTok) / n).toFixed(0)} avgOut=${(sum((s) => s.outTok) / n).toFixed(0)} ` +
        `cost/call=$${cost.toFixed(5)} avgMs=${(sum((s) => s.ms) / n).toFixed(0)}`,
    );
  }
  console.log('\nInvented items:');
  for (const s of samples) {
    if (inv(s) || trp(s)) console.log(`  ${s.caseId}/${s.rep} ${s.model}: invented=${JSON.stringify(s.judged!.invented)} traps=${JSON.stringify(s.judged!.trapsHit)}`);
  }
  console.log('\nDropped items:');
  for (const s of samples) if (drp(s)) console.log(`  ${s.caseId}/${s.rep} ${s.model}: ${JSON.stringify(s.judged!.dropped)}`);
  console.log(`\noutputs: ${OUT}\nspend this run: $${spend.toFixed(3)}`);
}

// â”€â”€ main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main(): Promise<void> {
  if (has('--gen')) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const which = opt('--gen-leg', 'both');
    if (which !== 'compact') {
      const fold = await pool(FOLD_SPECS, CONCURRENCY, (s) => genFold(s).then((c) => (console.log(`gen ${c.id} ${c.messages.length} msgs`), c)));
      writeFileSync(FOLD_CASES, JSON.stringify(fold, null, 2) + '\n');
    }
    if (which !== 'fold') {
      // --gen-case Cn regenerates one case and keeps the rest of the file.
      const only = opt('--gen-case');
      const specs = COMPACT_SPECS.filter((s) => !only || s.id === only);
      const comp = await pool(specs, CONCURRENCY, (s) => genCompact(s).then((c) => (console.log(`gen ${c.id} ${c.memory.length} chars`), c)));
      const kept = only && existsSync(COMPACT_CASES) ? (JSON.parse(readFileSync(COMPACT_CASES, 'utf8')) as CompactCase[]).filter((c) => c.id !== only) : [];
      writeFileSync(COMPACT_CASES, JSON.stringify([...kept, ...comp].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })), null, 2) + '\n');
    }
    console.log(`fixtures written to ${FIXTURE_DIR}; spend $${spend.toFixed(3)}`);
    return;
  }
  if (!existsSync(LEG === 'fold' ? FOLD_CASES : COMPACT_CASES)) throw new Error('no fixtures; run with --gen first');
  if (LEG === 'compact') await runCompact();
  else await runFold();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});




