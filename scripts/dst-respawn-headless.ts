// Headless two-shard respawn check (261104, scripts/dst-respawn-headless.ts): the REAL bot runtime
// (createRuntime), the REAL main DST module + watcher, the supervisor's
// dst-listen / dst-respawn-offer glue re-done here, a stub brain that attaches
// the real adapter and records the death turn's prompt text. Deaths are forced
// from the Master console.
//
// Setup (Linux dedicated server, see native/dst-mod/sei/README.md): a cluster
// with Master + Caves, this worktree's native/dst-mod/sei linked into the
// server's mods/ and enabled in both shards' modoverrides.lua, each shard
// started with `-console < <fifo>`, permanent day, and an invincible
// console-made stand-in player "Steve" (userid KU_test) on Master. Nothing
// else may hold discovery port 27424. Analytics are never initialized here.
//
//   npx tsx scripts/dst-respawn-headless.ts cap      4 deaths >20 s apart -> 3 respawns, then DST_DIED_TOO_OFTEN
//   npx tsx scripts/dst-respawn-headless.ts badspot  deaths 8 s after each respawn -> DST_DANGEROUS_SPOT
import { appendFileSync, writeFileSync } from 'node:fs';
import { createDontStarveGameModule } from '../src/main/games/dontstarve/index';
import { createDstWatcher } from '../src/main/games/dontstarve/watcher';
import { createDstLivesReporter } from '../src/main/games/dontstarve/sessionLives';
// @ts-ignore plain JS
import { createRuntime } from '../src/bot/adapter/dontstarve/runtime.js';

const MODE = process.argv[2] ?? 'cap';
// Master shard console FIFO (see native/dst-mod/sei/README.md, headless testing) and where to write the JSON result.
const FIFO = process.env.DST_MASTER_FIFO ?? '/tmp/dst-Master.fifo';
const OUT_DIR = process.env.DST_OUT_DIR ?? '/tmp';
const t0 = Date.now();
const out = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const con = (lua: string) => appendFileSync(FIFO, lua.replace(/\n/g, ' ') + '\n');

const watcher = createDstWatcher({ ports: [27424], log: (m) => out('WATCHER', m) });
const mod = createDontStarveGameModule({
  watcher,
  log: (m) => out('MODULE', m),
  loadConfig: async () => ({}) as never,
  getCharacter: async () => ({ name: 'Sui' }),
  getPackRoot: async () => '/nonexistent',
  detect: (async () => ({ kind: 'not_found' })) as never,
  install: (async () => ({ kind: 'not_found' })) as never,
  enable: (async () => {}) as never,
  isCurrent: async () => true,
  launch: async () => {},
});
mod.watcher.start({ onUpdate: () => {} });
const lives = createDstLivesReporter();

// Wait for both shards and Steve.
let hb: ReturnType<typeof watcher.latestHeartbeat> = null;
for (let i = 0; i < 60; i++) {
  hb = watcher.latestHeartbeat();
  if (hb?.players?.some((p) => p.userid === 'KU_test')) break;
  await sleep(1000);
}
out('heartbeat: caves', hb?.caves, 'phase', hb?.phase, 'players', JSON.stringify(hb?.players));
if (!hb?.players?.some((p) => p.userid === 'KU_test')) { out('FAIL no Steve'); process.exit(2); }

const results: Record<string, unknown>[] = [];
let ended: { error: string; message: string } | null = null;
let rt: any = null;
const deathTurns: any[] = [];
const prompts: string[] = [];

const config = {
  adapter: {
    kind: 'dontstarve',
    dontstarve: {
      username: 'Sui', session: hb.session, label: hb.world ?? 'SeiDeath', day: hb.day, season: hb.season, phase: hb.phase, caves: !!hb.caves,
      nearUserid: 'KU_test', nearName: 'Steve', prefab: 'wilson', survivorBrief: 'You are playing as Wilson.', announce: true,
      death_grace_ms: 2000,
    },
  },
  player_username: 'Steve',
  persona: { name: 'Sui', expanded: 'x' },
  _seiCompanions: [],
};

let adapterRef: any = null;
const hooks = {
  logger: { info: (m: string) => out('BOT', m), warn: (m: string) => out('BOT WARN', m), error: (m: string) => out('BOT ERR', m) },
  summonDeadlineAt: Date.now() + 30_000,
  createBrain: async (adapter: any) => {
    adapterRef = adapter;
    adapter.attach({
      onChat: () => {}, onAttacked: () => {}, onSpawn: () => out('BRAIN onSpawn'), onPlayerJoined: () => {}, onPlayerLeft: () => {},
      onDying: () => out('BRAIN onDying'),
      onDeath: (evt: any) => {
        deathTurns.push(evt);
        const text = adapter.eventAddendum('sei:death', { pos: evt.pos, deathText: evt.deathText, detail: evt.detail });
        prompts.push(text);
        out('BRAIN onDeath', JSON.stringify(evt));
        out('DEATH PROMPT:', text);
      },
    });
    return { stop: async () => out('BRAIN stop'), setCompanions: () => {} };
  },
  onBrainReady: () => out('onBrainReady'), onBrainLost: () => out('onBrainLost'),
  onConnected: () => out('onConnected'), onDisconnected: (d: unknown) => out('onDisconnected', JSON.stringify(d)),
  onError: (e: { error: string; message: string }) => { ended = e; out('onError', JSON.stringify(e)); },
  onDashboard: () => {}, emitVisionCapability: () => {},
  postPortMessage: (msg: any) => {
    out('PORT ->main', JSON.stringify({ ...msg, token: msg.token ? `${String(msg.token).slice(0, 4)}...` : undefined }));
    if (msg.type === 'dst-listen') {
      void mod.setSummonOffer('c1', { port: msg.port, token: msg.token, respawn: msg.respawn === true, nearUserid: msg.nearUserid })
        .then((r) => {
          out('setSummonOffer ->', JSON.stringify(r));
          if (msg.respawn === true) rt?.handlePortMessage({ type: 'dst-respawn-offer', ...r });
        });
    } else if (msg.type === 'dst-lives') {
      lives.note('c1', msg);
    } else if (msg.type === 'dst-offer-cancel') {
      void mod.setSummonOffer('c1', null);
    }
  },
};

rt = await createRuntime(config, hooks);

async function waitFor(pred: () => boolean, ms: number, what: string) {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function positions() {
  const self = rt.link.state.self;
  let steve: any = null;
  for (const e of rt.link.state.ents.values()) if (e.flags?.includes?.('player') && (e.name === 'Steve')) steve = e;
  return { self: self ? { x: self.x, z: self.z, hp: self.hp, inv: self.inv.map((i: any) => `${i.prefab}x${i.qty}`) } : null, steve: steve ? { x: steve.x, z: steve.z } : null };
}

function dist(p: any) { return p.self && p.steve ? Math.hypot(p.self.x - p.steve.x, p.self.z - p.steve.z) : null; }

const CAUSES = [
  `v.components.health:DoDelta(-10000, nil, "darkness")`,
  `v.components.health:DoDelta(-10000, nil, "hunger")`,
  `v.components.health:Kill()`,
  `v.components.health:DoDelta(-10000, nil, "cold")`,
];
function kill(i: number) {
  // Give her something first so the drop at the death spot is visible.
  con(`for _,v in pairs(Ents) do if v:IsValid() and v:HasTag("sei_companion") and v.components.health and not v.components.health:IsDead() then local l=SpawnPrefab("log"); l.components.stackable:SetStackSize(5); v.components.inventory:GiveItem(l); local x,_,z=v.Transform:GetWorldPosition(); print("[test] killing", v.GUID, x, z); ${CAUSES[i % CAUSES.length]} end end`);
}
function countLogsNear(x: number, z: number) {
  con(`local n=0; for _,e in ipairs(TheSim:FindEntities(${x},0,${z},4,{"_inventoryitem"})) do if e.prefab=="log" then n=n+(e.components.stackable and e.components.stackable:StackSize() or 1) end end; print("[test] logs near death spot", n)`);
}

try {
  await waitFor(() => !!rt.adapter && rt.link.state.hasFull, 30_000, 'first spawn');
  await sleep(1500);
  let p = positions();
  out('FIRST SPAWN', JSON.stringify(p), 'dist to Steve', dist(p)?.toFixed(1));
  results.push({ step: 'spawn', ...p, dist: dist(p) });

  const plan = MODE === 'cap' ? [25_000, 25_000, 25_000, 25_000] : [25_000, 8_000, 8_000];
  for (let i = 0; i < plan.length; i++) {
    const before = deathTurns.length;
    const deathPos = positions().self;
    out(`--- death ${i + 1}`);
    const tDeath = Date.now();
    kill(i);
    await waitFor(() => deathTurns.length > before || !!ended, 30_000, `death turn ${i + 1}`);
    const evt = deathTurns[deathTurns.length - 1];
    if (deathPos) countLogsNear(deathPos.x, deathPos.z);
    if (evt?.detail?.outcome === 'respawned') {
      await waitFor(() => rt.link.state.hasFull && !!rt.link.state.self, 10_000, 'respawned obs');
      await sleep(1500);
      p = positions();
      const ms = Date.now() - tDeath;
      out(`RESPAWNED ${i + 1} after ${(ms / 1000).toFixed(1)}s`, JSON.stringify(p), 'dist to Steve', dist(p)?.toFixed(1), 'lives', JSON.stringify(rt.lives));
      results.push({ step: `respawn${i + 1}`, ms, ...p, dist: dist(p), detail: evt.detail });
    } else {
      out(`FINAL death turn ${i + 1}`, JSON.stringify(evt?.detail));
      results.push({ step: `final${i + 1}`, detail: evt?.detail });
      await waitFor(() => !!ended, 15_000, 'session end');
      break;
    }
    if (i + 1 < plan.length) await sleep(plan[i + 1] - 1500);
  }
  await waitFor(() => !!ended, 15_000, 'session end');
} catch (err) {
  out('HARNESS ERROR', (err as Error).message);
}

out('ENDED', JSON.stringify(ended));
out('bot_session_ended props', JSON.stringify(lives.take('c1')));
writeFileSync(`${OUT_DIR}/dst-respawn-${MODE}.json`, JSON.stringify({ results, ended, prompts }, null, 2));
try { await rt.stop(); } catch {}
await sleep(1500);
watcher.stop();
process.exit(0);
