#!/usr/bin/env node
// One pilot run: private Xvfb + Chrome, a game, a task, and the
// screenshot -> model -> actions loop until the pass check fires, the model
// calls done, or the step/time budget runs out.
//
//   node run.mjs --task mc-walk --arm single|batch|random [--model claude-haiku-5-5]
//                [--rep 1] [--display 131] [--max-steps 60] [--max-seconds 180]
//
// Writes <out>/<runId>/steps.jsonl, step-NNN.jpg, clip.mp4 and appends one
// summary line to <out>/runs.jsonl. Prints one line per run.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { startDisplay, startChrome, startRecorder, finalizeVideo } from './env.mjs';
import { createInput, screenshot } from './input.mjs';
import { createAgent } from './agent.mjs';
import { TASKS } from './tasks.mjs';
import sharp from 'sharp';

// Pixel-only feedback: mean absolute difference of two 64x36 greyscale
// thumbnails, in percent. Tells the model when its actions changed nothing.
const thumb = (f) => sharp(f).resize(64, 36, { fit: 'fill' }).greyscale().raw().toBuffer();
const deltaPct = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return +(t / a.length / 2.55).toFixed(1); };

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const task = TASKS[args.task];
if (!task) { console.error(`unknown task ${args.task}; one of ${Object.keys(TASKS).join(', ')}`); process.exit(2); }
const arm = args.arm || 'single';
const model = args.model || 'claude-haiku-5-5';
const rep = Number(args.rep || 1);
const display = Number(args.display || 131);
const maxSteps = Number(args['max-steps'] || 60);
const maxSeconds = Number(args['max-seconds'] || 180);
const OUT = args.out || `${process.env.HOME}/suisei/reports/take-the-wheel-2026-11-03/runs`;
const SPEND_CAP = Number(args['spend-cap'] || 2.7);
const LEDGER = join(OUT, 'spend.json');

mkdirSync(OUT, { recursive: true });
const readSpend = () => { try { return JSON.parse(readFileSync(LEDGER, 'utf8')).total || 0; } catch { return 0; } };
const addSpend = (c) => { const t = readSpend() + c; writeFileSync(LEDGER + '.tmp', JSON.stringify({ total: t })); renameSync(LEDGER + '.tmp', LEDGER); return t; };
if (arm !== 'random' && readSpend() >= SPEND_CAP) { console.log(`spend ${readSpend().toFixed(3)} >= cap ${SPEND_CAP}; not starting`); process.exit(3); }

const modelTag = model.replace('claude-', '').replace(/-/g, '');
const runId = `${task.id}-${arm}-${arm === 'random' ? 'none' : modelTag}-r${rep}-${Date.now().toString(36)}`;
const dir = join(OUT, runId);
mkdirSync(dir, { recursive: true });
const stepLog = (o) => appendFileSync(join(dir, 'steps.jsonl'), JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };

const SKIP = new Set(['screenshot', 'zoom', 'cursor_position']);
const fmt = (a) => `${a.name} ${JSON.stringify(a.input)}`.slice(0, 140);

let disp, chrome, rec;
const summary = { runId, task: task.id, arm, model: arm === 'random' ? null : model, rep, pass: false };
try {
  disp = await startDisplay(display);
  chrome = await startChrome({ display, url: task.url });
  const page = chrome.page;
  summary.setup = await task.setup({ page, display });
  // Give the page keyboard focus, as a player's first click would.
  await page.bringToFront().catch(() => {});
  await page.evaluate(() => { window.focus(); document.body?.focus?.(); }).catch(() => {});
  const input = createInput({ display, pxPerDegree: task.pxPerDegree || 20, isPointerLocked: () => task.isPointerLocked(page) });
  const agent = arm === 'random' ? null : createAgent({ model, mode: arm });
  rec = startRecorder(display, join(dir, 'raw.mp4'), 6);

  const t0 = Date.now();
  let plan = null, cost = 0, actionsRun = 0, doneClaimed = false, last = await task.check(page);
  const recent = [], stepMs = [], perActionMs = [], modelMs = [];
  let usageTot = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let step = 0, prevThumb = null;
  for (step = 1; step <= maxSteps; step++) {
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed >= maxSeconds || last.pass) break;
    const ts = Date.now();
    const shot = join(dir, `step-${String(step).padStart(3, '0')}.jpg`);
    await screenshot(display, shot);
    const tShot = Date.now() - ts;
    let screenDelta = null;
    try { const th = await thumb(shot); if (prevThumb) screenDelta = deltaPct(prevThumb, th); prevThumb = th; } catch {}
    const locked = await task.isPointerLocked(page);
    let d;
    if (arm === 'random') {
      d = { actions: [{ name: 'key', input: { text: ['Up', 'Down', 'Left', 'Right'][Math.floor(Math.random() * 4)] } }], plan: null, usage: null, cost: 0, latencyMs: 0, dropped: 0 };
    } else {
      try {
        d = await agent.step({ task: task.prompt, hint: task.hint, plan, recent: recent.slice(-8), stepNo: step, maxSteps, secondsLeft: maxSeconds - elapsed, pointerLocked: locked, screenDelta, imageB64: readFileSync(shot).toString('base64') });
      } catch (e) {
        stepLog({ step, error: String(e).slice(0, 300) });
        recent.push(`turn ${step}: (model call failed)`);
        await sleep(1500);
        continue;
      }
    }
    cost += d.cost; if (d.cost) addSpend(d.cost);
    for (const k of Object.keys(usageTot)) usageTot[k] += (d.usage?.[k] || 0);
    if (d.plan) plan = d.plan;
    const te = Date.now();
    const results = [];
    for (const a of d.actions) {
      let r;
      if (a.name === 'done') { doneClaimed = true; r = 'OK'; }
      else if (SKIP.has(a.name)) r = 'skipped: a screenshot comes every turn';
      else {
        try { r = await withTimeout(input.run(a.name, a.input), 15000, a.name); } catch (e) { r = `error: ${String(e.message || e).slice(0, 120)}`; }
      }
      results.push(r); actionsRun++;
      recent.push(`turn ${step}: ${fmt(a)} -> ${r}`);
    }
    if (!d.actions.length) recent.push(`turn ${step}: (no action)`);
    await input.releaseAll();
    // Let the game settle (animations, merges) before the next look.
    await sleep(task.id === '2048' ? 150 : 250);
    const tExec = Date.now() - te;
    last = await task.check(page);
    const wall = Date.now() - ts;
    stepMs.push(wall); modelMs.push(d.latencyMs);
    if (d.actions.length) perActionMs.push(wall / d.actions.length);
    stepLog({ step, t: +((Date.now() - t0) / 1000).toFixed(2), shotMs: tShot, screenDelta, modelMs: d.latencyMs, execMs: tExec, wallMs: wall, usage: d.usage, cost: +d.cost.toFixed(6), plan: d.plan, text: d.text, actions: d.actions, dropped: d.dropped, results, check: last, locked });
    if (doneClaimed) break;
  }
  const wallS = (Date.now() - t0) / 1000;
  last = await task.check(page);
  Object.assign(summary, {
    pass: !!last.pass, metric: last.metric, note: last.note, steps: Math.min(step, maxSteps), actions: actionsRun, doneClaimed, falseDone: doneClaimed && !last.pass,
    wallS: +wallS.toFixed(1), cost: +cost.toFixed(5), costPerHour: wallS > 0 ? +(cost / wallS * 3600).toFixed(3) : 0,
    stepP50: pct(stepMs, 0.5) / 1000, stepP95: pct(stepMs, 0.95) / 1000, actP50: pct(perActionMs, 0.5) / 1000, actP95: pct(perActionMs, 0.95) / 1000,
    modelP50: pct(modelMs, 0.5) / 1000, usage: usageTot,
  });
} catch (e) {
  summary.error = String(e.stack || e).slice(0, 400);
} finally {
  try { if (rec) await rec.stop(); } catch {}
  try { if (chrome) await chrome.stop(); } catch {}
  try { if (disp) disp.stop(); } catch {}
}
try {
  if (existsSync(join(dir, 'raw.mp4'))) { await finalizeVideo(join(dir, 'raw.mp4'), join(dir, 'clip.mp4'), { speed: 1 }); rmSync(join(dir, 'raw.mp4')); }
} catch (e) { summary.videoError = String(e).slice(0, 200); }
appendFileSync(join(OUT, 'runs.jsonl'), JSON.stringify(summary) + '\n');
console.log(`${runId} pass=${summary.pass} ${summary.note || summary.error || ''} steps=${summary.steps} acts=${summary.actions} wall=${summary.wallS}s cost=$${summary.cost} actP50=${summary.actP50} spend=$${readSpend().toFixed(3)}`);
process.exit(0);
