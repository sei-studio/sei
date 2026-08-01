#!/usr/bin/env node
/**
 * Backseat lab (260731) — an offline bench for the parts of backseat that can
 * only be judged against real gameplay.
 *
 * Electron is never launched here. Starting the app spams "Sei Safe Storage"
 * keychain prompts, and none of what this measures needs a running session:
 * a video file plus ffmpeg reproduces the capture pipeline's input exactly.
 *
 * The geometry below is COPIED from src/shared/backseatIpc.ts rather than
 * imported, because that module is TypeScript inside the Electron build graph
 * and this script is plain node. The values are asserted against the real ones
 * by `npm test` (backseatIpc.test.ts pins the token budget), so a drift here
 * shows up as a failing grid rather than silently wrong research.
 *
 *   node scripts/backseat-lab.mjs frames <video>   extract a dense frame bank
 *   node scripts/backseat-lab.mjs grids            composite log-spaced grids
 *
 * Later subcommands (narrate, report) build on the artifacts these leave in
 * the work directory.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const exec = promisify(execFile);

// ── Geometry, mirrored from src/shared/backseatIpc.ts ─────────────────────
const CELL_W = 602;
const CELL_H = 336;
const GRID_COLS = 2;
const GRID_ROWS = 3;
const GRID_FRAMES = GRID_COLS * GRID_ROWS;
const GRID_W = CELL_W * GRID_COLS;
const GRID_H = CELL_H * GRID_ROWS;
const GRID_QUALITY = 82;

/**
 * The proposed log-spaced offsets, in seconds before the composite instant,
 * oldest first. Ratio 2, so the gaps halve as they approach the present: six
 * seconds of context, but four of the six cells inside the last 1.5 s where a
 * dodge-then-fire actually lives.
 */
const GRID_OFFSETS_S = [6.0, 3.0, 1.5, 0.75, 0.375, 0.1875];

/**
 * Frame bank rate. The finest offset gap is 0.1875 s, so a bank at 16 Hz
 * (62.5 ms) resolves every offset to within 31 ms. Dense enough to serve the
 * grids, and reusable later for tuning the visual signals frame by frame.
 */
const BANK_FPS = 16;

/** Anchors every 3 s. The real gate cadence is 6 s (GATE_INTERVAL_MS), so this
 *  oversamples by 2x: the runtime simulation subsamples back to 6 s, and the
 *  extra anchors just give the similarity study more pairs for free. */
const ANCHOR_INTERVAL_S = 3;

const WORK = process.env.BACKSEAT_LAB_DIR ?? path.join(process.cwd(), '.backseat-lab');
const BANK = path.join(WORK, 'frames');
/** Labelled and unlabelled grids live side by side so the two can be narrated
 *  by the same model and compared without re-extracting the frame bank. */
const variantTag = (o = {}) => `${o.labelled ? '-labelled' : ''}${o.reversed ? '-reversed' : ''}`;
const gridsDir = (o) => path.join(WORK, `grids${variantTag(o)}`);
const gridsIndex = (o) => path.join(WORK, `grids${variantTag(o)}.json`);

/** Frame file for a timestamp, 1-indexed the way ffmpeg numbers them. */
function frameFile(seconds) {
  const n = Math.max(0, Math.round(seconds * BANK_FPS)) + 1;
  return path.join(BANK, `${String(n).padStart(5, '0')}.jpg`);
}

/**
 * Extract every frame the grids can draw from, pre-scaled and letterboxed to
 * the exact cell size. `force_original_aspect_ratio=decrease` + `pad` is the
 * ffmpeg spelling of drawFitted() in captureWorker.ts: fit inside the cell,
 * centre it, fill the remainder black. Never stretch — the player can share a
 * portrait window, and a stretched frame is a frame the model reads wrong.
 */
async function cmdFrames(video) {
  if (!video) throw new Error('usage: backseat-lab.mjs frames <video>');
  await mkdir(BANK, { recursive: true });
  const filter =
    `fps=${BANK_FPS},scale=${CELL_W}:${CELL_H}:force_original_aspect_ratio=decrease,` +
    `pad=${CELL_W}:${CELL_H}:(ow-iw)/2:(oh-ih)/2:black`;
  console.log(`[lab] extracting ${BANK_FPS} fps frame bank from ${video}`);
  await exec('ffmpeg', [
    '-nostdin', '-v', 'error', '-y',
    '-i', video,
    '-vf', filter,
    '-q:v', '4',
    path.join(BANK, '%05d.jpg'),
  ], { maxBuffer: 1 << 26 });
  const n = (await readdir(BANK)).filter((f) => f.endsWith('.jpg')).length;
  console.log(`[lab] ${n} frames (${(n / BANK_FPS).toFixed(1)}s of video)`);
}

/**
 * One grid: the six log-spaced frames before `anchor`, oldest in the top-left,
 * filled row-first. Cells whose source frame is missing stay black rather than
 * shifting the others, matching composite() in captureWorker.ts — a missing
 * cell is honest, a shifted one silently lies about the timeline.
 */
async function buildGrid(anchor, { label = false, reversed = false } = {}) {
  const cells = [];
  // The reversal probe: same six frames, same labels, but reading position now
  // runs newest to oldest while the prompt still claims oldest to newest. A
  // model that actually uses position must narrate the sequence backwards; a
  // model that ignores position will say the same thing either way. The gap
  // between the two narrations IS the order sensitivity.
  const offsets = reversed ? [...GRID_OFFSETS_S].reverse() : GRID_OFFSETS_S;
  for (let i = 0; i < GRID_FRAMES; i++) {
    const t = anchor - offsets[i];
    if (t < 0) continue;
    const left = (i % GRID_COLS) * CELL_W;
    const top = Math.floor(i / GRID_COLS) * CELL_H;
    try {
      cells.push({ input: await sharp(frameFile(t)).toBuffer(), left, top });
    } catch {
      // Leave the cell black.
      continue;
    }
    if (label) {
      // Small, low-contrast, bottom-left of the cell. An in-image index is a
      // far stronger ordering signal than a sentence in the prompt, but it is
      // also something the model can leak into its reply, so it stays optional
      // until that is A/B'd.
      const svg = Buffer.from(
        `<svg width="${CELL_W}" height="${CELL_H}">` +
          `<text x="14" y="${CELL_H - 14}" font-family="monospace" font-size="26" ` +
          `fill="#fff" fill-opacity="0.55" stroke="#000" stroke-opacity="0.4" ` +
          `stroke-width="3" paint-order="stroke">${i + 1}</text></svg>`,
      );
      cells.push({ input: svg, left, top });
    }
  }
  if (!cells.length) return null;
  return await sharp({
    create: { width: GRID_W, height: GRID_H, channels: 3, background: 'black' },
  })
    .composite(cells)
    .jpeg({ quality: GRID_QUALITY })
    .toBuffer();
}

async function cmdGrids({ label = false, reversed = false } = {}) {
  const GRIDS = gridsDir({ labelled: label, reversed });
  await mkdir(GRIDS, { recursive: true });
  const frames = (await readdir(BANK)).filter((f) => f.endsWith('.jpg')).length;
  if (!frames) throw new Error('no frame bank — run `frames <video>` first');
  const duration = frames / BANK_FPS;
  const anchors = [];
  // Start past the widest offset so the first grid is complete.
  for (let t = GRID_OFFSETS_S[0]; t <= duration; t += ANCHOR_INTERVAL_S) anchors.push(t);

  const index = [];
  for (const anchor of anchors) {
    const buf = await buildGrid(anchor, { label, reversed });
    if (!buf) continue;
    const name = `grid-${anchor.toFixed(3).padStart(8, '0')}.jpg`;
    await writeFile(path.join(GRIDS, name), buf);
    index.push({ anchor, file: name, offsets: GRID_OFFSETS_S, bytes: buf.length });
  }
  await writeFile(gridsIndex({ labelled: label, reversed }), JSON.stringify(index, null, 2));
  const avg = Math.round(index.reduce((a, g) => a + g.bytes, 0) / index.length / 1024);
  console.log(`[lab] ${index.length} grids at ${GRID_W}x${GRID_H}, avg ${avg} KB -> ${GRIDS}`);
}

// ── Narration ─────────────────────────────────────────────────────────────

const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const NARRATOR_MODEL = process.env.SEI_GATE_MODEL || 'Qwen/Qwen3-VL-30B-A3B-Instruct';
/** Sampling temperature. The default 0 is what production would use; raising it
 *  produces the "same input, different sample" reference the reversal probe
 *  needs as its ceiling. Without that reference a high fwd-vs-reversed score is
 *  uninterpretable: it could mean the model ignored order, or just that two
 *  narrations of the same six frames share vocabulary. */
const TEMP = Number(process.env.SEI_LAB_TEMP ?? 0);
const TEMP_TAG = TEMP > 0 ? '-resampled' : '';

/**
 * How the grid's layout is explained. This is the part that has to be right
 * before anything downstream matters: IG-VLM (arXiv 2403.18406) found that
 * describing the layout and ordering explicitly is what makes a still-image
 * model read a grid as time rather than as six unrelated pictures.
 *
 * The offsets are stated because they are NOT uniform. Today's prompt claims
 * "about a second apart", which was already untrue (selection was an argmax
 * over audio gain) and is emphatically untrue now.
 */
const LAYOUT = (offsets) =>
  `This image is a ${GRID_ROWS}x${GRID_COLS} grid of ${GRID_FRAMES} frames from the last ` +
  `${offsets[0]} seconds of gameplay, in order: left to right along each row, then down to the ` +
  'next row. The frames are NOT evenly spaced. Reading oldest to newest they were captured ' +
  `${offsets.map((o) => `${o}`).join(', ')} seconds ago, so the gaps get finer toward the ` +
  'present and the last few frames are only fractions of a second apart. ';

/** The multi-image case needs no layout explanation: order is in the stream. */
const PROMPT_MULTI = (offsets) =>
  `These ${GRID_FRAMES} images are frames from the last ${offsets[0]} seconds of gameplay, ` +
  'given oldest first, each labelled with how long ago it was captured. ' +
  'Say what HAPPENED across them, as a sequence. Name concrete changes you can verify: ' +
  'shots fired, a kill or death, a reload, an ability used, a change of location, a score or ' +
  'ammo or health change. If nothing changed, say so plainly. Two short sentences maximum. ' +
  'Do not describe the scene in general terms, do not speculate, and do not mention frames or images.';

/** Free prose. One or two sentences naming the sequence and its outcome. */
const PROMPT_PROSE = (offsets) =>
  LAYOUT(offsets) +
  'Say what HAPPENED across these frames, as a sequence. Name concrete changes you can verify ' +
  'from the frames: shots fired, a kill or death, a reload, an ability used, a change of ' +
  'location, a score or ammo or health change. If nothing changed, say so plainly. ' +
  'Two short sentences maximum. Do not describe the scene in general terms, do not speculate, ' +
  'and do not mention frames, images, grids or screenshots.';

/**
 * Structured. The reason to test this: "walking" and "standing still and
 * shooting" on the SAME map share a scene and differ only in action. Free
 * prose about both will be dominated by map description and may not separate;
 * separate fields separate by construction.
 */
const PROMPT_JSON = (offsets) =>
  LAYOUT(offsets) +
  'Reply with ONLY a JSON object, no prose and no code fence, with exactly these keys: ' +
  '"scene" (where this is happening, a few words), ' +
  '"actions" (array of short verb phrases, in order, for what the player did), ' +
  '"events" (array of short phrases for things that happened to or around them: a kill, a death, ' +
  'a reload, an ability, an objective), ' +
  '"outcome" (a few words for how it ended, or "nothing" if nothing resolved), ' +
  '"static" (true if essentially nothing changed across the frames). ' +
  'Only include what you can verify from the frames.';

/**
 * The multi-image probe. The grid exists because IG-VLM was solving a case
 * where the model took ONE image; Qwen3-VL and Haiku both accept many. Sending
 * six separate images with "Frame N, X seconds ago" between them makes the
 * ordering explicit in the token stream rather than implicit in pixel layout,
 * at the same visual-token cost. If the grid is what is losing the sequence,
 * this is where it shows up.
 */
async function narrateFrames(frameB64s, offsets, prompt, key) {
  const content = [];
  frameB64s.forEach((b64, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1}, ${offsets[i]} seconds ago:` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  });
  content.push({ type: 'text', text: prompt });
  const res = await fetch(DEEPINFRA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: NARRATOR_MODEL, max_tokens: 220, temperature: TEMP,
      messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { text: body.choices?.[0]?.message?.content?.trim() ?? '', usage: body.usage ?? null };
}

async function narrateOne(gridB64, prompt, key) {
  const res = await fetch(DEEPINFRA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: NARRATOR_MODEL,
      max_tokens: 220,
      temperature: TEMP,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${gridB64}` } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return {
    text: body.choices?.[0]?.message?.content?.trim() ?? '',
    usage: body.usage ?? null,
  };
}

/** Bounded-concurrency map. DeepInfra is fine with a handful in flight and this
 *  keeps a 61-grid run under a minute without risking a 429 storm. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function cmdNarrate({ variant = 'prose', labelled = false, reversed = false } = {}) {
  const key = process.env.SEI_GATE_DEV_KEY;
  if (!key) throw new Error('SEI_GATE_DEV_KEY not set (it is in .env)');
  const GRIDS = gridsDir({ labelled, reversed });
  const index = JSON.parse(await readFile(gridsIndex({ labelled, reversed }), 'utf8'));
  const base = variant === 'json' ? PROMPT_JSON : variant === 'multi' ? PROMPT_MULTI : PROMPT_PROSE;
  // When the cells carry burned-in indices, point the model at them. This is
  // the whole hypothesis under test: a number in the pixels should beat a
  // sentence in the prompt for establishing reading order.
  const build = labelled
    ? (offsets) =>
        base(offsets).replace(
          'then down to the next row.',
          'then down to the next row. Each frame has its order number printed in its ' +
            'bottom-left corner, from 1 (oldest) to 6 (most recent) — trust those numbers ' +
            'for the ordering. Never mention the numbers in your answer.',
        )
    : base;
  const tag = `${variant}${variantTag({ labelled, reversed })}${TEMP_TAG}`;
  console.log(`[lab] narrating ${index.length} grids, variant=${tag}, model=${NARRATOR_MODEL}`);

  let failed = 0;
  let promptTokens = 0;
  let outTokens = 0;
  const t0 = Date.now();
  const results = await pool(index, 4, async (g) => {
    // Reversal probe for the multi-image case: feed the frames newest-first
    // while the LABELS still claim oldest-first, exactly as the reversed grid
    // lies with position. Same content, same claim, opposite truth.
    const pick = reversed ? [...g.offsets].reverse() : g.offsets;
    const frames = variant === 'multi'
      ? await Promise.all(pick.map(async (o) =>
          (await readFile(frameFile(g.anchor - o))).toString('base64')))
      : null;
    const b64 = variant === 'multi'
      ? null
      : (await readFile(path.join(GRIDS, g.file))).toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { text, usage } = frames
          ? await narrateFrames(frames, g.offsets, build(g.offsets), key)
          : await narrateOne(b64, build(g.offsets), key);
        promptTokens += usage?.prompt_tokens ?? 0;
        outTokens += usage?.completion_tokens ?? 0;
        return { anchor: g.anchor, file: g.file, text };
      } catch (err) {
        if (attempt === 2) {
          failed++;
          console.warn(`[lab] ${g.file} failed: ${err.message}`);
          return { anchor: g.anchor, file: g.file, text: '', error: String(err.message) };
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  });

  const out = path.join(WORK, `narrations-${tag}.json`);
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(
    `[lab] ${results.length - failed}/${results.length} narrated in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s, ${promptTokens} prompt + ${outTokens} output ` +
      `tokens -> ${out}`,
  );
}

// ── Similarity ────────────────────────────────────────────────────────────

/** Words that carry no signal about what happened. Deliberately short: the
 *  narrator's own boilerplate ("the player") is the thing worth stripping,
 *  and over-stripping starts deleting the verbs we are trying to compare. */
const STOP = new Set(
  ('a an the this that these those is are was were be been being do does did done ' +
    'and or but then they them their it its to of in on at from with as by for ' +
    'player players screen view frame frames shows showing appears seems')
    .split(' '),
);

const tokens = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/** TF-IDF cosine over the corpus. The IDF matters more than usual here: every
 *  narration says "fires" and "reloads", so without down-weighting the common
 *  terms every pair looks similar and the metric is dead on arrival. */
function lexicalScorer(corpus) {
  const docs = corpus.map(tokens);
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const vec = (toks) => {
    const tf = new Map();
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const idf = Math.log((N + 1) / ((df.get(w) ?? 0) + 1)) + 1;
      const x = (c / toks.length) * idf;
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  };
  const cache = new Map();
  const of = (s) => {
    if (!cache.has(s)) cache.set(s, vec(tokens(s)));
    return cache.get(s);
  };
  return (a, b) => {
    const va = of(a);
    const vb = of(b);
    let dot = 0;
    for (const [w, x] of va) dot += x * (vb.get(w) ?? 0);
    return dot;
  };
}

/** MiniLM cosine. 384-dim, q8, ~23 MB, ~3.5 s to load then milliseconds a call. */
async function embedScorer(corpus) {
  const { pipeline } = await import('@huggingface/transformers');
  const extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  const uniq = [...new Set(corpus)];
  const out = await extract(uniq, { pooling: 'mean', normalize: true });
  const byText = new Map(uniq.map((t, i) => [t, out.tolist()[i]]));
  return (a, b) => {
    const va = byText.get(a);
    const vb = byText.get(b);
    if (!va || !vb) return 0;
    let dot = 0;
    for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
    return dot;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
};
const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

async function loadSet(tag) {
  try {
    const rows = JSON.parse(await readFile(path.join(WORK, `narrations-${tag}.json`), 'utf8'));
    return rows.filter((r) => r.text);
  } catch {
    return null;
  }
}

async function cmdReport() {
  const variants = ['prose', 'prose-labelled', 'multi'];
  const sets = {};
  for (const v of [...variants, ...variants.map((v) => `${v}-reversed`)]) {
    const s = await loadSet(v);
    if (s) sets[v] = s;
  }
  if (!Object.keys(sets).length) throw new Error('no narrations — run `narrate` first');

  const corpus = Object.values(sets).flat().map((r) => r.text);
  const scorers = { lexical: lexicalScorer(corpus), embed: await embedScorer(corpus) };

  console.log('\n=== ORDER SENSITIVITY ===');
  console.log('Same six frames, reading order reversed. High similarity means the model');
  console.log('ignored position and the grid is being read as a bag of pictures.\n');
  console.log('variant                 method    fwd-vs-reversed   unrelated-pairs   gap');
  for (const v of variants) {
    const fwd = sets[v];
    const rev = sets[`${v}-reversed`];
    if (!fwd || !rev) continue;
    const byAnchor = new Map(rev.map((r) => [r.anchor, r.text]));
    for (const [name, sim] of Object.entries(scorers)) {
      const paired = fwd
        .filter((r) => byAnchor.has(r.anchor))
        .map((r) => sim(r.text, byAnchor.get(r.anchor)));
      const unrelated = [];
      for (let i = 0; i < fwd.length; i++) {
        for (let j = i + 1; j < fwd.length; j++) {
          if (Math.abs(fwd[i].anchor - fwd[j].anchor) > 30) unrelated.push(sim(fwd[i].text, fwd[j].text));
        }
      }
      console.log(
        `${v.padEnd(23)} ${name.padEnd(9)} ${f(mean(paired))}           ` +
          `${f(mean(unrelated))}            ${f(mean(paired) - mean(unrelated))}`,
      );
    }
  }

  console.log('\n=== SIMILARITY BY TIME GAP (forward grids only) ===');
  console.log('If novelty is going to gate speech, similarity must fall as the gap grows.\n');
  console.log('variant                 method     3s      6s     12s    >30s');
  for (const v of variants) {
    const rows = sets[v];
    if (!rows) continue;
    for (const [name, sim] of Object.entries(scorers)) {
      const bucket = { 3: [], 6: [], 12: [], far: [] };
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const dt = Math.abs(rows[i].anchor - rows[j].anchor);
          const s = sim(rows[i].text, rows[j].text);
          if (dt <= 3.01) bucket[3].push(s);
          else if (dt <= 6.01) bucket[6].push(s);
          else if (dt <= 12.01) bucket[12].push(s);
          else if (dt > 30) bucket.far.push(s);
        }
      }
      console.log(
        `${v.padEnd(23)} ${name.padEnd(9)} ${f(mean(bucket[3]))}  ${f(mean(bucket[6]))}  ` +
          `${f(mean(bucket[12]))}  ${f(mean(bucket.far))}`,
      );
    }
  }

  console.log('\n=== RUNTIME SIMULATION (6 s cadence, novelty vs last 5) ===');
  console.log('novelty = 1 - max similarity against the previous 5 narrations.');
  console.log('"speak rate" is the share of ticks that would wake the companion.\n');
  console.log('variant                 method    p10    p50    p90   speak@.25 @.35 @.45');
  for (const v of variants) {
    const rows = (sets[v] ?? []).filter((_, i) => i % 2 === 0);
    if (!rows.length) continue;
    for (const [name, sim] of Object.entries(scorers)) {
      const nov = [];
      for (let i = 1; i < rows.length; i++) {
        const prev = rows.slice(Math.max(0, i - 5), i);
        nov.push(1 - Math.max(...prev.map((p) => sim(rows[i].text, p.text))));
      }
      const rate = (t) => (nov.filter((n) => n >= t).length / nov.length).toFixed(2);
      console.log(
        `${v.padEnd(23)} ${name.padEnd(9)} ${f(pct(nov, 0.1))}  ${f(pct(nov, 0.5))}  ` +
          `${f(pct(nov, 0.9))}   ${rate(0.25)}   ${rate(0.35)}  ${rate(0.45)}`,
      );
    }
  }
  console.log('');
}

// ── Entry ─────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'frames') await cmdFrames(args[0]);
  else if (cmd === 'grids')
    await cmdGrids({ label: flags.has('--label'), reversed: flags.has('--reverse') });
  else if (cmd === 'narrate')
    await cmdNarrate({
      variant: flags.has('--json') ? 'json' : flags.has('--multi') ? 'multi' : 'prose',
      labelled: flags.has('--label'),
      reversed: flags.has('--reverse'),
    });
  else if (cmd === 'report') await cmdReport();
  else {
    console.error(
      'usage: backseat-lab.mjs <frames <video> | grids [--label] | narrate [--json] [--label] [--reverse] | report>',
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`[lab] ${err.message}`);
  process.exit(1);
}
