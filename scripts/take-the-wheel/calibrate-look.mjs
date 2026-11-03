// Calibration: turn 90 then -30 degrees with several relative-motion chunk
// sizes and gaps, and print what the Minecraft Classic camera actually did.
// Used to pick input.mjs defaults (TTW_LOOK_CHUNK / TTW_LOOK_GAP).
import { startDisplay, startChrome } from './env.mjs';
import { TASKS } from './tasks.mjs';
import { createInput } from './input.mjs';
let disp, chrome;
try {
  const task = TASKS['mc-walk'];
  disp = await startDisplay(133);
  chrome = await startChrome({ display: 133, url: task.url, cdpPort: 9433 });
  const page = chrome.page; await task.setup({ page, display: 133 });
  await page.bringToFront(); await page.evaluate(() => window.focus());
  const input = createInput({ display: 133, pxPerDegree: task.pxPerDegree, isPointerLocked: () => task.isPointerLocked(page) });
  const st = () => page.evaluate(() => ({ hd: window.__ttw.heading(), p: window.__ttw.pos().map((v) => +v.toFixed(1)), lock: !!document.pointerLockElement }));
  const log = [await st()];
  const res = [];
  for (const [ch, gap] of [[20, 15], [20, 25], [40, 40], [60, 60]]) {
    process.env.TTW_LOOK_CHUNK = ch; process.env.TTW_LOOK_GAP = gap;
    const a = (await st()).hd; await input.run('look', { yaw: 90 }); const b = (await st()).hd; await input.run('look', { yaw: -30 }); const c = (await st()).hd;
    res.push(`${ch}/${gap}: +90->${b - a} -30->${c - b}`);
  }
  console.log(res.join(' | '));
} catch (e) { console.log('ERR', String(e).slice(0, 300)); } finally { try { await chrome?.stop(); } catch {} try { disp?.stop(); } catch {} }
process.exit(0);
