// Testbeds and pass checks for the take-the-wheel pilot. Setup and grading
// read game state over CDP (window.noa, the 2048 DOM, Cookie Clicker's
// Game object); the model never sees any of it, only pixels.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Minecraft Classic (noa engine) ----------

const MC_URL = 'https://classic.minecraft.net/';
const MC_HINT = 'This is Minecraft Classic in a browser. W/A/S/D walk, space jumps, the mouse turns the camera. Left click breaks the block under the crosshair, right click places the selected hotbar block (reach is about 4 blocks). The number keys 1-9 pick a hotbar block.';

// Measured: 200 px of relative mouse motion turns the camera 0.16 rad.
export const MC_PX_PER_DEGREE = 21.8;

async function mcWaitReady(page) {
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const ok = await page.evaluate(() => {
      if (!(window.noa && noa.playerEntity)) return false;
      const q = noa.entities.getPosition(noa.playerEntity);
      return noa.world.getBlockSolidity(Math.floor(q[0]), Math.floor(q[1] - 0.5), Math.floor(q[2]));
    }).catch(() => false);
    if (ok) { await sleep(2500); return true; }
  }
  return false;
}

// Installs window.__ttw: block ids by material, a scanner, and a log of
// block edits near the player (break = solid -> air, place = air -> solid).
async function mcInstallHelpers(page) {
  await page.evaluate(() => {
    const r = noa.registry, w = noa.world;
    const idsWithMat = (name) => {
      const m = r._matIDs[name]; const out = [];
      for (let id = 1; id < 64; id++) for (let f = 0; f < 6; f++) if (r._blockMats[id * 6 + f] === m) { out.push(id); break; }
      return out;
    };
    const T = window.__ttw = {
      log: idsWithMat('tree_side'), water: idsWithMat('water'), edits: [],
      pos: () => { const p = noa.entities.getPosition(noa.playerEntity); return [p[0], p[1], p[2]]; },
      heading: () => { const o = noa.rendering._rotationHolder || noa.rendering._cameraHolder; return o ? Math.round((o.rotation.y * 180 / Math.PI) % 360) : null; },
      nearest(ids, yLo = -3, yHi = 3, R = 64) {
        const [px, py, pz] = T.pos(); let best = null;
        for (let x = Math.floor(px - R); x <= px + R; x++) for (let z = Math.floor(pz - R); z <= pz + R; z++) {
          if (x < 0 || z < 0 || x >= noa.worldSize || z >= noa.worldSize) continue;
          for (let y = Math.floor(py + yLo); y <= py + yHi; y++) {
            if (!ids.includes(w.getBlockID(x, y, z))) continue;
            const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
            if (!best || d < best.d) best = { d, x, y, z };
          }
        }
        return best;
      },
      // All trunk cells of the given ids that can be seen from the eye.
      visibleOf(ids, yLo, yHi, R, dMin, dMax) {
        const [px, py, pz] = T.pos(); const ey = py + 1.6; const out = [];
        for (let x = Math.floor(px - R); x <= px + R; x++) for (let z = Math.floor(pz - R); z <= pz + R; z++) {
          const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz); if (d < dMin || d > dMax) continue;
          for (let y = Math.floor(py + yLo); y <= py + yHi; y++) {
            if (!ids.includes(w.getBlockID(x, y, z))) continue;
            let clear = true; const n = Math.ceil(d * 4);
            for (let i = 1; i < n; i++) {
              const f = i / n; const cx = Math.floor(px + (x + 0.5 - px) * f), cy = Math.floor(ey + (y + 0.5 - ey) * f), cz = Math.floor(pz + (z + 0.5 - pz) * f);
              if (cx === x && cz === z) break;
              if (w.getBlockID(cx, cy, cz) !== 0) { clear = false; break; }
            }
            if (clear) out.push({ d, x, y, z });
          }
        }
        return out.sort((a, b) => a.d - b.d);
      },
      face(x, z) { const [px, , pz] = T.pos(); const h = Math.atan2(x + 0.5 - px, z + 0.5 - pz); for (const k of ['_rotationHolder', '_cameraHolder']) { const o = noa.rendering[k]; if (o) { o.rotation.y = h; o.rotation.x = 0; } } return h; },
      faceAway(x, z) { const h = T.face(x, z) + Math.PI; for (const k of ['_rotationHolder', '_cameraHolder']) { const o = noa.rendering[k]; if (o) o.rotation.y = h; } return h; },
    };
    const orig = w.setBlockID.bind(w);
    w.setBlockID = function (id, x, y, z) {
      try {
        const old = w.getBlockID(x, y, z); const [px, py, pz] = T.pos();
        if (Math.hypot(x + 0.5 - px, y + 0.5 - py, z + 0.5 - pz) < 8) {
          const solid = (b) => b !== 0 && !T.water.includes(b) && !!r._blockSolidity[b];
          if (old !== 0 && !T.water.includes(old) && id === 0) T.edits.push('break');
          else if ((old === 0 || T.water.includes(old)) && id !== 0 && solid(id)) T.edits.push('place');
        }
      } catch {}
      return orig(id, x, y, z);
    };
  });
}

async function mcClickToLock(display) {
  const env = { ...process.env, DISPLAY: `:${display}` };
  await pexec('xdotool', ['mousemove', '512', '288', 'click', '1'], { env });
  await sleep(700);
}

function mcTask({ id, prompt, prepare, check }) {
  return {
    id, url: MC_URL, game: 'minecraft-classic', pxPerDegree: MC_PX_PER_DEGREE, hint: MC_HINT, prompt,
    pointerLock: true,
    async setup(ctx) {
      for (let attempt = 0; attempt < 7; attempt++) {
        if (attempt > 0) await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        const t0 = Date.now();
        if (!(await mcWaitReady(ctx.page))) { console.error(`setup ${id} try ${attempt + 1}: world not ready`); continue; }
        await mcInstallHelpers(ctx.page);
        await mcClickToLock(ctx.display);
        const info = await prepare(ctx.page);
        console.error(`setup ${id} try ${attempt + 1}: ${info ? 'ok' : 'no suitable target'} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (info) { await sleep(1500); await ctx.page.evaluate(() => { window.__ttw.edits = []; }); return info; }
      }
      throw new Error('setup failed: no suitable world after 7 tries');
    },
    check,
    isPointerLocked: (page) => page.evaluate(() => !!document.pointerLockElement).catch(() => false),
  };
}

const mcWalk = mcTask({
  id: 'mc-walk',
  prompt: 'Walk to the tree in front of you and stand right next to its trunk, touching it.',
  // Put the player on open ground 7-11 blocks from a tree trunk on the same
  // level, with a clear line of sight from the eye to the trunk, facing it.
  async prepare(page) {
    const ok = await page.evaluate(() => {
      const T = window.__ttw, w = noa.world, N = noa.worldSize;
      const solidTop = (x, z) => { for (let y = 70; y >= 1; y--) { const b = w.getBlockID(x, y, z); if (b !== 0) return { y, b }; } return null; };
      const clear = (ax, ay, az, bx, by, bz) => { const d = Math.hypot(bx - ax, by - ay, bz - az), n = Math.ceil(d * 4); for (let i = 1; i < n; i++) { const f = i / n; const cx = Math.floor(ax + (bx - ax) * f), cy = Math.floor(ay + (by - ay) * f), cz = Math.floor(az + (bz - az) * f); if (cx === Math.floor(bx) && cz === Math.floor(bz)) return true; if (w.getBlockID(cx, cy, cz) !== 0) return false; } return true; };
      const [px, , pz] = T.pos(); const bases = [];
      for (let x = 4; x < N - 4; x++) for (let z = 4; z < N - 4; z++) { const t = solidTop(x, z); if (!t) continue; for (let y = t.y; y > 20; y--) { const b = w.getBlockID(x, y, z); if (T.log.includes(b) && !T.log.includes(w.getBlockID(x, y - 1, z)) && w.getBlockSolidity(x, y - 1, z)) { bases.push({ x, y, z, dp: Math.hypot(x - px, z - pz) }); break; } } }
      bases.sort((a, b) => a.dp - b.dp);
      for (const t of bases.slice(0, 40)) {
        for (let k = 0; k < 16; k++) {
          const ang = k * Math.PI / 8; const r = 7 + (k % 5);
          const sx = Math.floor(t.x + 0.5 + Math.sin(ang) * r), sz = Math.floor(t.z + 0.5 + Math.cos(ang) * r);
          if (sx < 1 || sz < 1 || sx >= N - 1 || sz >= N - 1) continue;
          const top = solidTop(sx, sz); if (!top || T.water.includes(top.b) || T.log.includes(top.b) || !w.getBlockSolidity(sx, top.y, sz)) continue;
          const sy = top.y + 1; if (Math.abs(sy - t.y) > 1 || w.getBlockID(sx, sy + 1, sz) !== 0) continue;
          if (!clear(sx + 0.5, sy + 1.6, sz + 0.5, t.x + 0.5, t.y + 1.5, t.z + 0.5)) continue;
          noa.entities.setPosition(noa.playerEntity, sx + 0.5, sy + 0.05, sz + 0.5);
          T.target = { x: t.x, y: t.y, z: t.z, d: Math.hypot(t.x - sx, t.z - sz) };
          return true;
        }
      }
      return false;
    });
    if (!ok) return null;
    await sleep(2500);
    return page.evaluate(() => { const T = window.__ttw, t = T.target; T.face(t.x, t.z); const [px, , pz] = T.pos(); return { targetDist: +Math.hypot(t.x + 0.5 - px, t.z + 0.5 - pz).toFixed(1) }; });
  },
  async check(page) {
    return page.evaluate(() => {
      const T = window.__ttw; const t = T.nearest(T.log, -1, 2, 6); const [px, py, pz] = T.pos();
      const d = t ? t.d : 99; const dt = T.target ? Math.hypot(T.target.x + 0.5 - px, T.target.z + 0.5 - pz) : 99;
      return { pass: d <= 1.6, metric: +Math.min(d, dt).toFixed(2), note: `nearest trunk ${d.toFixed(1)}, start tree ${dt.toFixed(1)} blocks`, pos: [px, py, pz].map((v) => +v.toFixed(1)), hd: T.heading() };
    });
  },
});

const mcBlocks = mcTask({
  id: 'mc-blocks',
  prompt: 'Break one block, then place a block anywhere.',
  async prepare() { return { ok: true }; },
  async check(page) {
    return page.evaluate(() => {
      const e = window.__ttw.edits; const b = e.includes('break'), p = e.includes('place');
      return { pass: b && p, metric: (b ? 1 : 0) + (p ? 1 : 0), note: `edits ${e.join(',') || 'none'}` };
    });
  },
});

const mcFind = mcTask({
  id: 'mc-find',
  prompt: 'Find water and walk to its edge, so you are standing within two blocks of the water. The water may not be in view at the start.',
  // Spawns are often beside the sea, so move the player to dry land 12-30
  // blocks (4-neighbour steps) from the nearest water, then face away from it.
  async prepare(page) {
    const ok = await page.evaluate(() => {
      const T = window.__ttw, w = noa.world, N = noa.worldSize;
      const wet = new Uint8Array(N * N), dist = new Int16Array(N * N).fill(-1), q = [];
      for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) for (let y = 70; y >= 0; y--) { const b = w.getBlockID(x, y, z); if (b === 0) continue; if (T.water.includes(b)) { wet[x * N + z] = 1; dist[x * N + z] = 0; q.push(x * N + z); } break; }
      if (!q.length) return { ok: false, why: 'no water' };
      for (let h = 0; h < q.length; h++) { const c = q[h], x = Math.floor(c / N), z = c % N; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, nz = z + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue; const k = nx * N + nz; if (dist[k] < 0) { dist[k] = dist[c] + 1; q.push(k); } } }
      const [px, , pz] = T.pos(); let best = null, far = 0, maxD = 0;
      for (let x = 2; x < N - 2; x++) for (let z = 2; z < N - 2; z++) {
        const d = dist[x * N + z]; maxD = Math.max(maxD, d); if (d < 12 || d > 30) continue; far++;
        let top = -1; for (let y = 70; y >= 20; y--) { const b = w.getBlockID(x, y, z); if (b !== 0) { top = (T.log.includes(b) || !w.getBlockSolidity(x, y, z)) ? -2 : y; break; } }
        if (top < 31 || w.getBlockID(x, top + 1, z) !== 0 || w.getBlockID(x, top + 2, z) !== 0) continue;
        const dp = Math.hypot(x - px, z - pz); if (!best || dp < best.dp) best = { x, z, y: top + 1, dp, d };
      }
      if (!best) return { ok: false, why: `wet ${q.length}, maxDist ${maxD}, far ${far}, no standable cell` };
      noa.entities.setPosition(noa.playerEntity, best.x + 0.5, best.y + 0.05, best.z + 0.5);
      return { ok: true };
    });
    if (!ok.ok) { console.error(`mc-find: ${ok.why}`); return null; }
    await sleep(3000);
    const r = await page.evaluate(() => {
      const T = window.__ttw; const t = T.nearest(T.water, -12, 2, 64);
      if (!t || t.d < 9) return { miss: t ? +t.d.toFixed(1) : 'none', pos: T.pos().map((v) => +v.toFixed(1)) };
      T.faceAway(t.x, t.z); T.target = t; return { targetDist: +t.d.toFixed(1) };
    });
    if (r.miss !== undefined) { console.error(`mc-find: after the move nearest water ${r.miss} at ${r.pos}`); return null; }
    return r;
  },
  async check(page) {
    return page.evaluate(() => {
      const T = window.__ttw; const t = T.nearest(T.water, -4, 1, 40); const [px, py, pz] = T.pos();
      const d = t ? t.d : 99; return { pass: d <= 2.5, metric: +d.toFixed(2), note: `nearest water ${d.toFixed(1)} blocks`, pos: [px, py, pz].map((v) => +v.toFixed(1)), hd: T.heading() };
    });
  },
});

// ---------- 2048 ----------

const g2048 = {
  // The GitHub Pages copy redirects to an ad-funded site by script; serve it
  // with that one script removed so the original open-source game stays up.
  id: '2048', url: null, game: '2048',
  hint: 'This is 2048. The arrow keys slide all tiles; equal tiles merge.',
  prompt: 'Reach a 256 tile.',
  async setup(ctx) {
    const URL2048 = 'https://gabrielecirulli.github.io/2048/';
    await ctx.page.route(URL2048, async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<script>\s*if \(typeof window[\s\S]*?<\/script>/, '');
      await route.fulfill({ response: res, body: html });
    });
    await ctx.page.goto(URL2048, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ctx.page.waitForSelector('.tile', { timeout: 30000 });
    // The page scrolls; keep the board in view and give it focus.
    await ctx.page.evaluate(() => { document.querySelector('.game-container')?.scrollIntoView({ block: 'center' }); });
    await sleep(800);
    return { ok: true };
  },
  async check(page) {
    return page.evaluate(() => {
      let max = 0;
      for (const t of document.querySelectorAll('.tile')) { const m = /tile-(\d+)/.exec(t.className); if (m) max = Math.max(max, +m[1]); }
      const score = parseInt(document.querySelector('.score-container')?.firstChild?.textContent || '0', 10);
      const over = !!document.querySelector('.game-over');
      return { pass: max >= 256, metric: max, note: `max tile ${max}, score ${score}${over ? ', game over' : ''}`, score, over };
    });
  },
  isPointerLocked: async () => false,
};

// ---------- Cookie Clicker (menus) ----------

const cookie = {
  id: 'cookie', url: 'https://orteil.dashnet.org/cookieclicker/', game: 'cookie-clicker',
  hint: 'This is Cookie Clicker. The game starts on a language screen.',
  prompt: 'Start the game in English and close the cookie notice. Click the big cookie until you can afford a Cursor and buy one Cursor in the store on the right. Rename your bakery to Sei (click the bakery name above the big cookie). Finally open the Stats menu.',
  async setup(ctx) { await sleep(6000); return { ok: true }; },
  async check(page) {
    return page.evaluate(() => {
      const G = window.Game; if (!G || !G.ready) return { pass: false, metric: 0, note: 'language not chosen' };
      const cur = G.Objects?.Cursor?.amount || 0; const menu = G.onMenu || '';
      const named = String(G.bakeryName || '').trim().toLowerCase() === 'sei';
      const ms = 1 + (G.cookiesEarned >= 15 ? 1 : 0) + (cur >= 1 ? 1 : 0) + (named ? 1 : 0) + (menu === 'stats' ? 1 : 0);
      return { pass: cur >= 1 && named && menu === 'stats', metric: ms, note: `earned ${Math.floor(G.cookiesEarned)}, cursors ${cur}, bakery ${JSON.stringify(String(G.bakeryName || '').slice(0, 20))}, menu ${menu || 'none'}` };
    }).catch(() => ({ pass: false, metric: 0, note: 'no game' }));
  },
  isPointerLocked: async () => false,
};

export const TASKS = { 'mc-walk': mcWalk, 'mc-blocks': mcBlocks, 'mc-find': mcFind, 2048: g2048, cookie };
