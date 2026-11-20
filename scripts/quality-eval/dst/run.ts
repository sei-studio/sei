// DST quality eval driver (scripts/quality-eval/dst/run.ts, 261104).
//
// Small, cheap, state-judged checks of the Don't Starve Together companion on
// a headless Linux dedicated server, with the REAL brain (claude-haiku-5-5
// over the dev test key) and the REAL main-side DST module + watcher:
//
//   server.ts         the SeiTest Master shard, console on a pipe, by PID
//   lua.ts            console helpers; QE_P prints ground truth as JSON
//   companion-dst.mjs one bot process per rep (src/bot/index.js init)
//   run.ts            this file: scenarios, pass/fail from game state, cost
//
// Scenarios (pass decided from game state; see SCENARIOS below):
//   night_dusk      summoned at the start of dusk, host stands in the dark
//   night_dark      summoned at night, host stands in the dark
//   night_hostlight summoned at night beside a host holding a torch
//   hostiles        hounds (odd reps) or spiders (even reps) near both
//   follow          the host walks ~60 tiles (240 units) in 40 s
//   errand_twigs    "can you get me 10 twigs?"
//   errand_grass    "get me some grass please" (3+ counts)
//   hunger          her hunger set to 12% with berries and carrots near
//   errand_chat     twig errand with "how's it going?" asked 30 s in; one
//                   small Haiku judge call on her answer
//
// Usage (one heavy eval on the box at a time: ~/suisei/eval/QUEUE.md):
//   npx tsx scripts/quality-eval/dst/run.ts --arm base --repo <checkout> \
//     --out ~/suisei/reports/quality/<dir> [--scenarios a,b] [--reps 3] [--budget 4] [--world <dir>]
//
// --world (default <out>/world-snapshot) pins the world: the first arm saves
// the cluster's save there and every later arm starts from that copy.
//
// --repo is the checkout whose bot (src/bot) and helper mod
// (native/dst-mod/sei) are under test; ~/dst-server/mods/sei is pointed at
// its mod for the run and pointed back afterwards. Writes <out>/<arm>.jsonl
// (one row per rep), <out>/<arm>/ logs, and prints a pass-rate table.
// Nothing here initializes analytics. The key is read by the bot child and
// the judge from ~/.sei-dev/anthropic-test-key and is never printed.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDontStarveGameModule } from '../../../src/main/games/dontstarve/index';
import { createDstWatcher } from '../../../src/main/games/dontstarve/watcher';
import { startServer, pointModAt, pinWorld, type DstServer } from './server';
import { HELPERS } from './lua';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ARM = arg('arm', 'base')!;
const REPO = path.resolve(arg('repo', path.resolve(here, '..', '..', '..'))!);
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'suisei', 'reports', 'quality', 'dst-eval'))!);
const WORLD = path.resolve(arg('world', path.join(OUT, 'world-snapshot'))!);
const REPS = Number(arg('reps', '3'));
const BUDGET = Number(arg('budget', '4'));
const CHAR = arg('character', path.join(os.homedir(), 'suisei', 'eval', 'characters', 'sui.json'))!;
const KEY_FILE = path.join(os.homedir(), '.sei-dev', 'anthropic-test-key');
const PRICE = { in: 0.10, out: 0.50, cw: 0.125, cr: 0.01 }; // claude-haiku-5-5, report.mjs PRICES
const SPEND_LOG = path.join(OUT, 'spend.log');

const ALL = ['night_dusk', 'night_dark', 'night_hostlight', 'hostiles', 'follow', 'errand_twigs', 'errand_grass', 'hunger', 'errand_chat'];
const scenarioNames = (arg('scenarios') ?? ALL.join(',')).split(',').filter(Boolean);
const repsFor = (name: string) => Number(arg(`reps-${name}`, String(REPS)));

mkdirSync(path.join(OUT, ARM), { recursive: true });
const t0 = Date.now();
const log = (...a: unknown[]) => {
  const s = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  process.stdout.write(s + '\n');
  appendFileSync(path.join(OUT, ARM, 'driver.log'), s + '\n');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (u: any) => (u ? ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out
  + (u.cache_creation_input_tokens || 0) * PRICE.cw + (u.cache_read_input_tokens || 0) * PRICE.cr) / 1e6 : 0);

function priorSpend(): number {
  if (!existsSync(SPEND_LOG)) return 0;
  let s = 0;
  for (const ln of readFileSync(SPEND_LOG, 'utf8').split('\n')) { const m = /usd=([\d.]+)/.exec(ln); if (m) s += Number(m[1]); }
  return s;
}

// ── probes ──────────────────────────────────────────────────────────────
type Probe = any;
let srv: DstServer;
let probeSeq = 0;
let curLives: any = null;
async function probe(): Promise<Probe | null> {
  const tag = `p${++probeSeq}`;
  const w = srv.waitTagged('qe-p', 3000, (o) => o.tag === tag);
  srv.con(`QE_P("${tag}")`);
  return w;
}
const dist = (p: Probe) => (p && p.bx != null && p.sx != null ? Math.hypot(p.bx - p.sx, p.bz - p.sz) : null);
const delivered = (p: Probe, prefab: string) => (p?.sinv?.[prefab] ?? 0) + (p?.sground?.[prefab] ?? 0);

// ── one bot process ────────────────────────────────────────────────────
interface Bot {
  child: ChildProcess;
  events: any[];
  lives: any;
  ended: any;
  usd: () => number;
  turns: () => number;
  stop: () => Promise<void>;
}

function startBot(mod: ReturnType<typeof createDontStarveGameModule>, dir: string, repId: string): Bot {
  const join = mod.getJoinTarget({ userConfig: {} } as never);
  const userData = path.join(dir, `${repId}-userdata`);
  mkdirSync(userData, { recursive: true });
  const child = spawn(process.execPath, [path.join(here, 'companion-dst.mjs')], {
    env: {
      ...process.env,
      QE_BOT_REPO: REPO, QE_CHARACTER: CHAR, QE_JOIN: JSON.stringify(join), QE_USERDATA: userData,
      QE_RAW_LOG: path.join(dir, `${repId}.raw.log`), QE_PLAYER: 'Steve',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const bot: Bot = {
    child, events: [], lives: null, ended: null,
    usd: () => bot.events.filter((e) => e.kind === 'llm_turn').reduce((s, e) => s + usd(e.usage), 0),
    turns: () => bot.events.filter((e) => e.kind === 'llm_turn').length,
    async stop() {
      if (child.exitCode != null) return;
      try { child.stdin!.write(JSON.stringify({ type: 'stop' }) + '\n'); } catch {}
      const t = Date.now();
      while (child.exitCode == null && Date.now() - t < 12_000) await sleep(200);
      if (child.exitCode == null) { try { process.kill(child.pid!, 'SIGKILL'); } catch {} }
      await sleep(300);
    },
  };
  const evOut = path.join(dir, `${repId}.events.jsonl`);
  let buf = '';
  child.stdout!.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!ln.startsWith('@@QE ')) continue;
      let ev: any;
      try { ev = JSON.parse(ln.slice(5)); } catch { continue; }
      bot.events.push(ev);
      appendFileSync(evOut, JSON.stringify(ev) + '\n');
      if (ev.kind === 'chat_out') log(`  [${repId}] Sui: ${String(ev.text).slice(0, 140)}`);
      if (ev.kind === 'action_call') log(`  [${repId}] act ${ev.name} ${JSON.stringify(ev.args ?? {}).slice(0, 100)}`);
      if (ev.kind !== 'port') continue;
      const msg = ev.data;
      if (msg.type === 'dst-listen') {
        void mod.setSummonOffer('qe', { port: msg.port, token: msg.token, respawn: msg.respawn === true, nearUserid: msg.nearUserid })
          .then((r) => { if (msg.respawn === true) child.stdin!.write(JSON.stringify({ type: 'dst-respawn-offer', ...r }) + '\n'); });
      } else if (msg.type === 'dst-offer-cancel') {
        void mod.setSummonOffer('qe', null);
      } else if (msg.type === 'dst-lives') {
        bot.lives = msg; curLives = msg;
      } else if (msg.type === 'error' || msg.type === 'summon-stopped' || msg.type === 'status') {
        if (msg.type === 'error') { bot.ended = msg; log(`  [${repId}] bot error ${msg.error ?? ''}`); }
      }
    }
  });
  child.stderr!.on('data', (c: Buffer) => appendFileSync(path.join(dir, `${repId}.stderr.log`), c));
  return bot;
}

// ── scenarios ──────────────────────────────────────────────────────────
interface Ctx { rep: number; bot: Bot; probes: Probe[]; tick: () => Promise<Probe | null>; say: (t: string) => void }
interface Scenario {
  /** Before the summon: world reset arguments + Lua run after the reset. */
  phase: string;
  segs?: Record<string, number>;
  setup?: (rep: number) => string[];
  /** After the body is up. Returns metrics incl. pass. */
  run: (c: Ctx) => Promise<Record<string, unknown> & { pass: boolean }>;
}

const NIGHT_SEGS = { day: 11, dusk: 2, night: 3 };
const RESOURCES = ['QE_RING("grass",5,5,14,false)', 'QE_RING("sapling",5,5,14,false)'];

/** Damage, deaths and grue hits summed over every body of the rep (a death respawns a new one). */
function sumBodies(probes: Probe[]) {
  const by = new Map<number, any>();
  for (const p of probes) if (p?.guid != null && p.qe) by.set(p.guid, p.qe);
  let dmg = 0, grue = 0, hits = 0, kills = 0, eats = 0, crafts = 0;
  const causes: Record<string, number> = {};
  for (const q of by.values()) {
    dmg += q.dmg || 0; grue += q.grue || 0; hits += q.hits || 0; kills += q.kills || 0; eats += q.eats || 0; crafts += q.crafts || 0;
    for (const [k, v] of Object.entries(q.causes || {})) causes[k] = (causes[k] || 0) + Number(v);
  }
  const deaths = Math.max(probes.some((p) => p?.dead) ? 1 : 0, by.size - 1, curLives?.deaths ?? 0);
  return { bodies: by.size, deaths, death_cause: curLives?.lastDeathCause ?? null, dmg: Math.round(dmg), grue, hits, kills, eats, crafts, causes };
}

async function nightRun(c: Ctx, maxMs: number) {
  const t = Date.now();
  let sawNight = false, nightN = 0, nightLit = 0, torchHeld = 0, fireNear = 0;
  while (Date.now() - t < maxMs) {
    const p = await c.tick();
    if (p?.ph === 'night') {
      sawNight = true; nightN++;
      if (p.inlight) nightLit++;
      if (p.hand === 'torch') torchHeld++;
      if (p.fires > 0) fireNear++;
    }
    if (sawNight && p?.ph === 'day') break;
    await sleep(1000);
  }
  const last = c.probes[c.probes.length - 1];
  const s = sumBodies(c.probes);
  const alive = !!last && last.dead === false && s.deaths === 0;
  return {
    pass: alive && s.grue === 0, alive, reached_day: last?.ph === 'day', ...s,
    night_lit_frac: nightN ? +(nightLit / nightN).toFixed(2) : null,
    night_torch_frac: nightN ? +(torchHeld / nightN).toFixed(2) : null,
    night_fire_frac: nightN ? +(fireNear / nightN).toFixed(2) : null,
    end_inv: last?.inv ?? null,
  };
}

async function errandRun(c: Ctx, line: string, prefab: string, need: number, maxMs: number, midLine?: string) {
  c.say(line);
  const t = Date.now();
  let doneMs: number | null = null, asked = false, askAt = 0;
  while (Date.now() - t < maxMs) {
    const p = await c.tick();
    if (doneMs == null && p && delivered(p, prefab) >= need) doneMs = Date.now() - t;
    // Ask at 30 s, or as soon as she finishes if that is sooner, then give her
    // 15 s to answer before ending the rep.
    if (midLine && !asked && (Date.now() - t > 30_000 || doneMs != null)) { c.say(midLine); asked = true; askAt = Date.now(); }
    if (doneMs != null && (!midLine || Date.now() - askAt > 16_000)) break;
    await sleep(1000);
  }
  const last = c.probes[c.probes.length - 1];
  const s = sumBodies(c.probes);
  return { pass: doneMs != null, done_ms: doneMs, delivered: delivered(last, prefab), her_inv: last?.inv?.[prefab] ?? 0, ...s, askAt };
}

const SCENARIOS: Record<string, Scenario> = {
  night_dusk: {
    phase: 'dusk', segs: { day: 10, dusk: 4, night: 2 }, setup: () => RESOURCES,
    run: (c) => nightRun(c, 230_000),
  },
  night_dark: {
    phase: 'night', segs: NIGHT_SEGS, setup: () => RESOURCES,
    run: (c) => nightRun(c, 130_000),
  },
  night_hostlight: {
    phase: 'night', segs: NIGHT_SEGS, setup: () => [...RESOURCES, 'QE_TORCH()'],
    run: (c) => nightRun(c, 130_000),
  },
  hostiles: {
    phase: 'day',
    run: async (c) => {
      await sleep(4000);
      const prefab = c.rep % 2 === 1 ? 'hound' : 'spider';
      srv.con(`QE_HOSTILE("${prefab}",${prefab === 'hound' ? 2 : 3},10)`);
      const t = Date.now();
      while (Date.now() - t < 60_000) { await c.tick(); await sleep(1000); }
      const last = c.probes[c.probes.length - 1];
      const s = sumBodies(c.probes);
      const near = (last?.hostiles ?? []).map((h: any) => h.d);
      const nearest = near.length ? Math.min(...near) : null;
      const alive = !!last && last.dead === false && s.deaths === 0;
      const helped = s.hits > 0 || s.kills > 0;
      const fled = nearest == null || nearest >= 12;
      return { pass: alive && (helped || fled), alive, helped, fled, prefab, hostiles_left: near.length, nearest, ...s };
    },
  },
  follow: {
    phase: 'day',
    run: async (c) => {
      await sleep(4000);
      srv.con('QE_ROUTE(240)');
      await sleep(500);
      const ds: number[] = [];
      const t = Date.now();
      let k = 0;
      while (Date.now() - t < 40_000) {
        srv.con('QE_STEP(3)');
        await sleep(500);
        if (++k % 2 === 0) { const p = await c.tick(); const d = dist(p); if (d != null) ds.push(d); }
      }
      for (let i = 0; i < 15; i++) { const p = await c.tick(); const d = dist(p); if (d != null) ds.push(d); await sleep(1000); }
      const walk = ds.slice(0, ds.length - 15);
      const end = ds[ds.length - 1] ?? null;
      const within20 = walk.length ? walk.filter((d) => d <= 20).length / walk.length : 0;
      const first = c.probes[0], last = c.probes[c.probes.length - 1];
      const hostMoved = first && last ? Math.hypot(last.sx - first.sx, last.sz - first.sz) : 0;
      return {
        pass: end != null && end <= 12 && within20 >= 0.9, end_dist: end != null ? +end.toFixed(1) : null,
        max_dist: walk.length ? +Math.max(...walk).toFixed(1) : null, within20: +within20.toFixed(2), host_moved: +hostMoved.toFixed(0), ...sumBodies(c.probes),
      };
    },
  },
  errand_twigs: {
    phase: 'day', setup: () => ['QE_RING("sapling",12,8,20,false)'],
    run: async (c) => { await sleep(4000); return errandRun(c, 'Sui, can you get me 10 twigs?', 'twigs', 10, 180_000); },
  },
  errand_grass: {
    phase: 'day', setup: () => ['QE_RING("grass",10,8,20,false)'],
    run: async (c) => { await sleep(4000); return errandRun(c, 'Sui get me some grass please', 'cutgrass', 3, 150_000); },
  },
  errand_chat: {
    phase: 'day', setup: () => ['QE_RING("sapling",12,8,20,false)'],
    run: async (c) => {
      await sleep(4000);
      const r = await errandRun(c, 'Sui, can you get me 10 twigs?', 'twigs', 10, 180_000, "how's it going?");
      const askAt = Number(r.askAt) || 0;
      // Her answer often arrives as several short chat lines ("there" / "10 twigs
      // steve"), so judge every line she says in the 15 s after the question.
      const lines = askAt ? c.bot.events.filter((e) => e.kind === 'chat_out' && e.t >= askAt && e.t <= askAt + 15_000).map((e) => String(e.text)) : [];
      const reply = lines.length ? lines.join(' / ') : null;
      const judge = askAt ? await judgeReply("how's it going?", reply) : null;
      return { ...r, pass: !!r.pass && judge?.ok === true, errand_pass: r.pass, reply, judge };
    },
  },
  hunger: {
    phase: 'day', setup: () => ['QE_RING("berrybush",4,8,16,false)', 'QE_RING("carrot_planted",3,8,16,false)'],
    run: async (c) => {
      await sleep(3000);
      srv.con('local b=QE_BODY(); if b then b.components.hunger:SetPercent(0.12) end');
      const t = Date.now();
      let minHu = 1;
      while (Date.now() - t < 130_000) { const p = await c.tick(); if (p?.hu != null) minHu = Math.min(minHu, p.hu); await sleep(1000); }
      const s = sumBodies(c.probes);
      const starve = Math.round(s.causes.hunger ?? 0);
      const last = c.probes[c.probes.length - 1];
      return { pass: s.eats > 0 && starve === 0 && s.deaths === 0, min_hunger: +minHu.toFixed(3), end_hunger: last?.hu ?? null, starve_dmg: starve, ...s };
    },
  },
};

// ── judge (errand_chat only): one small Haiku call ─────────────────────
let judgeUsd = 0;
async function judgeReply(question: string, reply: string | null) {
  if (!reply) return { ok: false, why: 'no reply within 15 s' };
  const { default: Anthropic } = await import(path.join(REPO, 'node_modules', '@anthropic-ai', 'sdk', 'index.js')).catch(() => import('@anthropic-ai/sdk'));
  const client = new Anthropic({ apiKey: readFileSync(KEY_FILE, 'utf8').trim() });
  const prompt = `A player in Don't Starve Together asked their AI companion to fetch 10 twigs. While she was out picking saplings, the player typed: "${question}"\nHer chat lines in the next 15 seconds, in order, were: "${reply}"\n\nDo her lines answer the question sensibly given what she is doing (fetching twigs, or having just finished)? A short status update about the task counts as an answer. Reply with YES or NO on the first line, then one short sentence.`;
  const res = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 60, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] } as never) as any;
  judgeUsd += usd(res.usage);
  const text = (res.content ?? []).map((b: any) => b.text ?? '').join('').trim();
  return { ok: /^yes/i.test(text), why: text.slice(0, 200) };
}

// ── main ───────────────────────────────────────────────────────────────
const prevLink = pointModAt(path.join(REPO, 'native', 'dst-mod', 'sei'));
log(`arm=${ARM} repo=${REPO} mod link was ${prevLink}`);
const restoreLink = () => { if (prevLink) { try { unlinkSync(path.join(os.homedir(), 'dst-server', 'mods', 'sei')); symlinkSync(prevLink, path.join(os.homedir(), 'dst-server', 'mods', 'sei')); } catch {} } };

log(`world ${pinWorld(WORLD)} (${WORLD})`);
srv = await startServer({ logPath: path.join(OUT, ARM, 'server.log'), log: (m) => log('SERVER', m) });
let watcher: ReturnType<typeof createDstWatcher> | null = null;
const shutdown = async (code: number) => {
  try { watcher?.stop(); } catch {}
  try { await srv.stop(); } catch {}
  restoreLink();
  process.exit(code);
};
process.on('SIGINT', () => { void shutdown(130); });
process.on('SIGTERM', () => { void shutdown(143); });

for (const h of HELPERS) srv.con(h);
srv.con('QE_STEVE()');
await sleep(1000);

watcher = createDstWatcher({ ports: [27424], log: (m) => appendFileSync(path.join(OUT, ARM, 'watcher.log'), m + '\n') });
const mod = createDontStarveGameModule({
  watcher, log: () => {},
  loadConfig: async () => ({}) as never, getCharacter: async () => ({ name: 'Sui' }), getPackRoot: async () => '/nonexistent',
  detect: (async () => ({ kind: 'not_found' })) as never, install: (async () => ({ kind: 'not_found' })) as never,
  enable: (async () => {}) as never, isCurrent: async () => true, launch: async () => {},
});
mod.watcher.start({ onUpdate: () => {} });
for (let i = 0; i < 60; i++) {
  if (watcher.latestHeartbeat()?.players?.some((p) => p.userid === 'KU_test')) break;
  await sleep(1000);
}
const hb0 = watcher.latestHeartbeat();
log('heartbeat', { mod: (hb0 as any)?.mod, players: hb0?.players?.length, phase: hb0?.phase });
if (!hb0?.players?.some((p) => p.userid === 'KU_test')) { log('FAIL: no heartbeat with Steve'); await shutdown(2); }

const rowsPath = path.join(OUT, `${ARM}.jsonl`);
let spent = priorSpend();
log(`prior spend in ${OUT}: $${spent.toFixed(3)} (budget $${BUDGET})`);

outer:
for (const name of scenarioNames) {
  const sc = SCENARIOS[name];
  if (!sc) { log(`unknown scenario ${name}`); continue; }
  for (let rep = 1; rep <= repsFor(name); rep++) {
    if (spent >= BUDGET) { log(`budget reached ($${spent.toFixed(3)}), stopping`); break outer; }
    const repId = `${name}-${rep}`;
    log(`=== ${repId}`);
    srv.con('QE_CLEARBODY()');
    srv.con(`QE_RESET("${sc.phase}",${luaTable(sc.segs ?? { day: 10, dusk: 4, night: 2 })})`);
    await srv.waitTagged('qe-reset', 5000);
    for (const l of sc.setup?.(rep) ?? []) srv.con(l);
    await sleep(2500); // next heartbeat carries the new phase
    curLives = null;
    const bot = startBot(mod, path.join(OUT, ARM), repId);
    const probes: Probe[] = [];
    const tick = async () => { const p = await probe(); if (p) probes.push(p); return p; };
    let up: Probe | null = null;
    const ts = Date.now();
    while (Date.now() - ts < 45_000 && !bot.ended) {
      const p = await probe();
      if (p?.guid != null && p.dead === false) { up = p; break; }
      await sleep(1000);
    }
    let row: Record<string, unknown>;
    if (!up) {
      row = { pass: false, error: bot.ended?.error ?? 'no body within 45 s' };
    } else {
      probes.push(up);
      try {
        row = await sc.run({ rep, bot, probes, tick, say: (t) => { srv.con(`QE_SAY(${JSON.stringify(t)})`); log(`  [${repId}] Steve: ${t}`); } });
      } catch (err) {
        row = { pass: false, error: `harness: ${(err as Error).message}` };
      }
    }
    await bot.stop();
    const cost = bot.usd();
    spent += cost;
    appendFileSync(SPEND_LOG, `${new Date().toISOString()} arm=${ARM} rep=${repId} turns=${bot.turns()} usd=${cost.toFixed(5)}\n`);
    const says = bot.events.filter((e) => e.kind === 'chat_out').length;
    const acts = bot.events.filter((e) => e.kind === 'action_call').map((e) => e.name);
    const full = { arm: ARM, scenario: name, rep, ...row, turns: bot.turns(), usd: +cost.toFixed(5), says, acts, lives: bot.lives, bot_error: bot.ended?.error ?? null };
    appendFileSync(rowsPath, JSON.stringify(full) + '\n');
    log(`--- ${repId} ${row.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(row).slice(0, 400)} turns=${bot.turns()} $${cost.toFixed(4)} total=$${spent.toFixed(3)}`);
    srv.con('QE_CLEARBODY()');
    await sleep(3000);
  }
}

if (judgeUsd > 0) { appendFileSync(SPEND_LOG, `${new Date().toISOString()} arm=${ARM} judge usd=${judgeUsd.toFixed(5)}\n`); spent += judgeUsd; }
summarize(rowsPath);
log(`total spend in ${OUT}: $${spent.toFixed(3)}`);
await shutdown(0);

function luaTable(o: Record<string, number>) { return `{${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(',')}}`; }

function summarize(p: string) {
  if (!existsSync(p)) return;
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = new Map<string, any[]>();
  for (const r of rows) { if (!by.has(r.scenario)) by.set(r.scenario, []); by.get(r.scenario)!.push(r); }
  const lines = [`arm ${ARM}: scenario  pass/n`];
  for (const [k, rs] of by) lines.push(`  ${k.padEnd(16)} ${rs.filter((r) => r.pass).length}/${rs.length}`);
  log(lines.join('\n'));
  writeFileSync(path.join(OUT, `${ARM}.summary.txt`), lines.join('\n') + '\n');
}
