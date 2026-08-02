/**
 * Backseat review video (260801).
 *
 * Takes a finished `backseat-sim` run and renders the clip back out with
 * everything the pipeline was monitoring drawn alongside it: the log-spaced
 * image grid that was actually sent to the model, the audio gain trace against
 * its rolling baseline and jolt threshold, the colour delta against its
 * threshold, the offline STT transcript, and the wake state (which source last
 * fired, and when the next scheduled look is due).
 *
 * Every commentary line is labelled with the wake mechanism that produced it,
 * which is the point of the artefact: it makes "did gain and colour fire on the
 * right things" a thing you can watch rather than a table to read.
 *
 * Inputs, all produced by earlier steps and none of them re-derived here:
 *   voiceover.json    scripts/backseat-sim.ts   turns, wake kinds, signals, replies
 *   signals.csv       scripts/backseat-sim.ts   gain / baseline / colour per 100 ms
 *   grids/NNN-kind.jpg scripts/backseat-sim.ts  the exact image each turn saw
 *   transcript.json   scripts/backseat-transcribe.ts
 *
 * Nothing about the run is recomputed, so the video cannot disagree with
 * voiceover.md.
 *
 * Usage:
 *   npx tsx scripts/backseat-render.ts [out-dir] [--fps 30] [--limit 20]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { GRID_OFFSETS_S, JOLT_COLOR_DELTA, JOLT_GAIN_DB } from '../src/shared/backseatIpc';

// ---------------------------------------------------------------- args / io

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const OUT = path.resolve(positional[0] ?? '.backseat-sim/valorant-clips');
const FPS = Number(opt('fps', '30'));
const LIMIT_S = Number(opt('limit', '0')); // 0 = whole clip; small values for a quick look
const DEST = path.join(OUT, 'review.mp4');

interface Turn {
  t: number;
  kind: 'user' | 'jolt' | 'idle';
  joltReason?: 'gain' | 'color';
  signal?: { gainDb: number; baseDb: number; colorDelta: number };
  offsets: Array<number | null>;
  reply: string;
  spoke: boolean;
}
const vo = JSON.parse(readFileSync(path.join(OUT, 'voiceover.json'), 'utf8')) as {
  video: string;
  TH: { gainDb: number; colorDelta: number; refractoryMs: number };
  seed: number;
  turns: Turn[];
};
const VIDEO = vo.video;

/** ms, gain_db, base_db, jump_db, color_delta at SAMPLE_INTERVAL_MS. */
const steps = readFileSync(path.join(OUT, 'signals.csv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [ms, gain, base, jump, color] = line.split(',');
    return {
      ms: Number(ms),
      gain: Number(gain),
      base: Number(base),
      jump: Number(jump),
      color: color === '' ? null : Number(color),
    };
  });
const STEP_MS = steps.length > 1 ? steps[1].ms - steps[0].ms : 100;

const transcript = existsSync(path.join(OUT, 'transcript.json'))
  ? (JSON.parse(readFileSync(path.join(OUT, 'transcript.json'), 'utf8')) as {
      chunks: Array<{ from: number; to: number; text: string }>;
    }).chunks
  : [];

const gridFiles = readdirSync(path.join(OUT, 'grids'))
  .filter((f) => f.endsWith('.jpg'))
  .sort();

const gainJolts = vo.turns.filter((t) => t.joltReason === 'gain').map((t) => t.t);
const colorJolts = vo.turns.filter((t) => t.joltReason === 'color').map((t) => t.t);

// ---------------------------------------------------------------- geometry

const W = 1920;
const H = 1080;

const VID = { x: 24, y: 72, w: 1280, h: 720 };
const SAY = { x: 24, y: 812, w: 1280, h: 244 };
const COL = { x: 1328, w: 568 };

const GRID = { y: 72, h: 536, img: { w: 568, h: 476, y: 100 }, strip: { y: 576, h: 20 } };
const GAIN = { y: 618, h: 140, plot: { y: 646, h: 108 } };
const CLR = { y: 774, h: 140, plot: { y: 802, h: 108 } };
const TXT = { y: 930, h: 126 };

const WINDOW_MS = 10_000; // how much history the two traces show

const C = {
  bg: '#0e1013',
  panel: '#161a21',
  edge: '#262c38',
  ink: '#e8ecf3',
  dim: '#8b94a5',
  faint: '#4b5464',
  user: '#6ea8fe',
  gain: '#ffab5e',
  color: '#5ccfe6',
  idle: '#98a2b3',
  thresh: '#c0566b',
};

const kindColor = (t: Turn): string =>
  t.kind === 'user' ? C.user : t.kind === 'idle' ? C.idle : t.joltReason === 'gain' ? C.gain : C.color;

/** The label the video shows for a wake. This is the whole point of the render. */
const kindLabel = (t: Turn): string => {
  if (t.kind === 'user') return 'PLAYER MESSAGE';
  if (t.kind === 'idle') return 'SCHEDULED LOOK';
  return t.joltReason === 'gain' ? 'JOLT · AUDIO GAIN' : 'JOLT · COLOUR CHANGE';
};

const kindDetail = (t: Turn): string => {
  if (t.kind === 'idle') return 'idle timer fired, nothing prompted it';
  if (t.kind === 'user') return 'player said something';
  if (!t.signal) return '';
  return t.joltReason === 'gain'
    ? `${(t.signal.gainDb - t.signal.baseDb >= 0 ? '+' : '')}${(t.signal.gainDb - t.signal.baseDb).toFixed(1)} dB over baseline (threshold +${JOLT_GAIN_DB})`
    : `delta ${t.signal.colorDelta.toFixed(3)} (threshold ${JOLT_COLOR_DELTA})`;
};

// ---------------------------------------------------------------- svg helpers

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Greedy wrap on an estimated advance width. Close enough for a fixed layout. */
function wrap(text: string, px: number, size: number, factor = 0.5): string[] {
  const max = Math.max(8, Math.floor(px / (size * factor)));
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

function panel(x: number, y: number, w: number, h: number, stroke = C.edge): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${C.panel}" stroke="${stroke}" stroke-width="1"/>`;
}

function label(x: number, y: number, text: string, color = C.dim, size = 13): string {
  return `<text x="${x}" y="${y}" font-family="Helvetica, Arial" font-size="${size}" font-weight="600" letter-spacing="1.4" fill="${color}">${esc(text)}</text>`;
}

function txt(
  x: number,
  y: number,
  text: string,
  o: { size?: number; color?: string; weight?: number; anchor?: string; mono?: boolean } = {},
): string {
  const fam = o.mono ? 'Menlo, monospace' : 'Helvetica, Arial';
  return `<text x="${x}" y="${y}" font-family="${fam}" font-size="${o.size ?? 15}" font-weight="${o.weight ?? 400}" fill="${o.color ?? C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(text)}</text>`;
}

// ---------------------------------------------------------------- traces

interface PlotOpts {
  y: number;
  h: number;
  lo: number;
  hi: number;
  color: string;
  /** value -> y, already clamped */
  series: Array<{ ms: number; v: number | null }>;
  baseline?: Array<{ ms: number; v: number }>;
  threshold?: Array<{ ms: number; v: number }>;
  /** jolt times of this arm, drawn as vertical markers when in window */
  marks?: number[];
  axis?: [string, string];
  now: number;
}

function plot(o: PlotOpts): string {
  const x0 = COL.w + COL.x;
  const map = (ms: number): number =>
    COL.x + 16 + ((ms - (o.now - WINDOW_MS)) / WINDOW_MS) * (COL.w - 32);
  const mapV = (v: number): number =>
    o.y + o.h - ((Math.min(o.hi, Math.max(o.lo, v)) - o.lo) / (o.hi - o.lo)) * o.h;

  const poly = (pts: Array<{ ms: number; v: number }>, color: string, width: number, dash = ''): string => {
    if (pts.length < 2) return '';
    const d = pts.map((p) => `${map(p.ms).toFixed(1)},${mapV(p.v).toFixed(1)}`).join(' ');
    return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>`;
  };

  const parts: string[] = [];
  parts.push(
    `<rect x="${COL.x + 16}" y="${o.y}" width="${COL.w - 32}" height="${o.h}" fill="#0b0d11" stroke="${C.edge}" stroke-width="1" rx="4"/>`,
  );
  if (o.threshold) parts.push(poly(o.threshold, C.thresh, 1.5, '4 4'));
  if (o.baseline) parts.push(poly(o.baseline, C.faint, 1.5));
  const solid = o.series.filter((p) => p.v !== null) as Array<{ ms: number; v: number }>;
  parts.push(poly(solid, o.color, 2));
  for (const m of o.marks ?? []) {
    if (m < o.now - WINDOW_MS || m > o.now) continue;
    const x = map(m);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${o.y}" x2="${x.toFixed(1)}" y2="${o.y + o.h}" stroke="${o.color}" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.85"/>`,
    );
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${o.y + 7}" r="4" fill="${o.color}"/>`,
    );
  }
  if (o.axis) {
    parts.push(txt(COL.x + 22, o.y + 13, o.axis[1], { size: 10, color: C.faint, mono: true }));
    parts.push(txt(COL.x + 22, o.y + o.h - 5, o.axis[0], { size: 10, color: C.faint, mono: true }));
  }
  // the present is the right-hand edge
  parts.push(
    `<line x1="${x0 - 16}" y1="${o.y}" x2="${x0 - 16}" y2="${o.y + o.h}" stroke="${C.dim}" stroke-width="1"/>`,
  );
  return parts.join('');
}

// ---------------------------------------------------------------- one frame

const gridCache = new Map<number, Buffer>();
async function gridFor(index: number): Promise<Buffer> {
  const hit = gridCache.get(index);
  if (hit) return hit;
  const buf = await sharp(path.join(OUT, 'grids', gridFiles[index]))
    .resize(GRID.img.w - 4, GRID.img.h - 4, { fit: 'fill' })
    .toBuffer();
  gridCache.set(index, buf);
  return buf;
}

function frameSvg(now: number): string {
  const lastIdx = (() => {
    let k = -1;
    for (let i = 0; i < vo.turns.length; i++) if (vo.turns[i].t <= now) k = i;
    return k;
  })();
  const last = lastIdx >= 0 ? vo.turns[lastIdx] : null;
  const sinceLook = last ? now - last.t : Infinity;
  const flash = sinceLook < 1400;

  // the most recent line that was actually spoken
  let spokenIdx = -1;
  for (let i = 0; i <= lastIdx; i++) if (vo.turns[i].spoke) spokenIdx = i;
  const spoken = spokenIdx >= 0 ? vo.turns[spokenIdx] : null;

  const nextIdle = vo.turns.find((t) => t.kind === 'idle' && t.t > now) ?? null;

  const i0 = Math.max(0, Math.floor((now - WINDOW_MS) / STEP_MS));
  const i1 = Math.min(steps.length - 1, Math.floor(now / STEP_MS));
  const win = steps.slice(i0, i1 + 1);
  const cur = steps[i1] ?? steps[steps.length - 1];

  const s: string[] = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);

  // --- background everywhere except the video hole
  s.push(`<rect x="0" y="0" width="${W}" height="${VID.y}" fill="${C.bg}"/>`);
  s.push(`<rect x="0" y="${VID.y}" width="${VID.x}" height="${VID.h}" fill="${C.bg}"/>`);
  s.push(
    `<rect x="${VID.x + VID.w}" y="${VID.y}" width="${W - VID.x - VID.w}" height="${VID.h}" fill="${C.bg}"/>`,
  );
  s.push(
    `<rect x="0" y="${VID.y + VID.h}" width="${W}" height="${H - VID.y - VID.h}" fill="${C.bg}"/>`,
  );

  // --- header
  s.push(txt(24, 44, 'backseat v2', { size: 22, weight: 700 }));
  s.push(
    txt(160, 44, 'what wakes the companion, and what it sees when it does', {
      size: 15,
      color: C.dim,
    }),
  );

  // priority legend: the three wake sources in the order they preempt
  const chips: Array<{ text: string; color: string; on: boolean }> = [
    { text: 'PLAYER', color: C.user, on: !!last && flash && last.kind === 'user' },
    {
      text: 'JOLT',
      color: last?.joltReason === 'color' ? C.color : C.gain,
      on: !!last && flash && last.kind === 'jolt',
    },
    { text: 'IDLE', color: C.idle, on: !!last && flash && last.kind === 'idle' },
  ];
  let cx = 760;
  chips.forEach((c, i) => {
    const w = 18 + c.text.length * 9;
    s.push(
      `<rect x="${cx}" y="24" width="${w}" height="26" rx="4" fill="${c.color}" opacity="${c.on ? 0.9 : 0.1}" stroke="${c.color}" stroke-width="1" stroke-opacity="${c.on ? 1 : 0.35}"/>`,
    );
    s.push(
      txt(cx + 9, 42, c.text, { size: 13, weight: 700, color: c.on ? '#0b0d11' : c.color }),
    );
    cx += w;
    if (i < chips.length - 1) {
      s.push(txt(cx + 8, 42, '>', { size: 14, color: C.faint }));
      cx += 26;
    }
  });
  s.push(txt(cx + 14, 42, 'higher preempts lower, never queued', { size: 12, color: C.faint }));
  s.push(
    txt(W - 24, 44, `${clock(now)} / ${clock(steps[steps.length - 1].ms)}`, {
      size: 18,
      color: C.dim,
      anchor: 'end',
      mono: true,
    }),
  );

  // --- video frame border, lit by the wake source while a look is fresh
  const lit = last && flash ? kindColor(last) : C.edge;
  s.push(
    `<rect x="${VID.x - 2}" y="${VID.y - 2}" width="${VID.w + 4}" height="${VID.h + 4}" rx="4" fill="none" stroke="${lit}" stroke-width="${flash ? 3 : 1}"/>`,
  );
  if (last && flash) {
    s.push(
      `<rect x="${VID.x + 16}" y="${VID.y + 16}" width="${18 + kindLabel(last).length * 9}" height="30" rx="4" fill="${kindColor(last)}" opacity="0.92"/>`,
    );
    s.push(txt(VID.x + 25, VID.y + 37, kindLabel(last), { size: 14, weight: 700, color: '#0b0d11' }));
    const detail = kindDetail(last);
    if (detail) {
      s.push(
        `<rect x="${VID.x + 16}" y="${VID.y + 50}" width="${16 + detail.length * 7}" height="24" rx="4" fill="#0b0d11" opacity="0.75"/>`,
      );
      s.push(txt(VID.x + 24, VID.y + 67, detail, { size: 13, color: kindColor(last), mono: true }));
    }
    // what the model did with this look, once it is clear
    const verdict = last.spoke ? '-> spoke' : '-> (silence)';
    s.push(
      `<rect x="${VID.x + 16}" y="${VID.y + (detail ? 78 : 50)}" width="${16 + verdict.length * 7}" height="24" rx="4" fill="#0b0d11" opacity="0.75"/>`,
    );
    s.push(
      txt(VID.x + 24, VID.y + (detail ? 95 : 67), verdict, {
        size: 13,
        color: last.spoke ? C.ink : C.dim,
        mono: true,
      }),
    );
  }

  // --- commentary panel
  s.push(panel(SAY.x, SAY.y, SAY.w, SAY.h));
  s.push(label(SAY.x + 20, SAY.y + 28, 'COMPANION'));

  if (spoken) {
    const c = kindColor(spoken);
    s.push(
      `<rect x="${SAY.x + 20}" y="${SAY.y + 44}" width="${14 + kindLabel(spoken).length * 8}" height="24" rx="4" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="1"/>`,
    );
    s.push(txt(SAY.x + 27, SAY.y + 61, kindLabel(spoken), { size: 13, weight: 700, color: c }));
    s.push(
      txt(SAY.x + 44 + kindLabel(spoken).length * 8, SAY.y + 61, `${clock(spoken.t)}  ${kindDetail(spoken)}`, {
        size: 13,
        color: C.dim,
      }),
    );
    const lines = wrap(`"${spoken.reply}"`, SAY.w - 48, 26, 0.49).slice(0, 3);
    lines.forEach((ln, i) => s.push(txt(SAY.x + 22, SAY.y + 104 + i * 34, ln, { size: 26 })));
  } else {
    s.push(txt(SAY.x + 22, SAY.y + 104, 'nothing said yet', { size: 26, color: C.faint }));
  }

  // last look outcome + wake state, along the bottom of the panel
  const foot = SAY.y + SAY.h - 20;
  s.push(
    `<line x1="${SAY.x + 20}" y1="${foot - 34}" x2="${SAY.x + SAY.w - 20}" y2="${foot - 34}" stroke="${C.edge}" stroke-width="1"/>`,
  );
  if (last) {
    const verdict = last.spoke ? 'spoke' : 'chose (silence)';
    s.push(
      txt(
        SAY.x + 22,
        foot - 8,
        `last look ${clock(last.t)}  ${kindLabel(last)}  ->  ${verdict}`,
        { size: 14, color: last.spoke ? C.ink : C.dim, mono: true },
      ),
    );
  }
  if (nextIdle) {
    s.push(
      txt(SAY.x + SAY.w - 22, foot - 8, `next scheduled look in ${((nextIdle.t - now) / 1000).toFixed(1)}s`, {
        size: 14,
        color: C.dim,
        anchor: 'end',
        mono: true,
      }),
    );
  }

  // --- grid panel
  s.push(panel(COL.x, GRID.y, COL.w, GRID.h, flash && last ? kindColor(last) : C.edge));
  s.push(label(COL.x + 16, GRID.y + 26, 'IMAGE GRID SENT TO THE MODEL'));
  s.push(
    txt(COL.x + COL.w - 16, GRID.y + 26, last ? `look at ${clock(last.t)}` : 'none yet', {
      size: 12,
      color: C.dim,
      anchor: 'end',
      mono: true,
    }),
  );
  if (!last) {
    s.push(
      `<rect x="${COL.x + 2}" y="${GRID.img.y}" width="${GRID.img.w - 4}" height="${GRID.img.h - 4}" fill="#0b0d11"/>`,
    );
  }

  // the log-spaced offset strip: where the six cells were taken from
  const sx = COL.x + 16;
  const sw = COL.w - 32;
  const span = GRID_OFFSETS_S[0];
  s.push(
    `<line x1="${sx}" y1="${GRID.strip.y + 8}" x2="${sx + sw}" y2="${GRID.strip.y + 8}" stroke="${C.faint}" stroke-width="1"/>`,
  );
  GRID_OFFSETS_S.forEach((off, i) => {
    const x = sx + (1 - off / span) * sw;
    const on = last && last.offsets[i] !== null;
    s.push(
      `<circle cx="${x.toFixed(1)}" cy="${GRID.strip.y + 8}" r="${i === GRID_OFFSETS_S.length - 1 ? 4 : 3}" fill="${on ? (last && flash ? kindColor(last) : C.ink) : C.faint}"/>`,
    );
  });
  s.push(txt(sx, GRID.strip.y + 24, `-${span.toFixed(1)}s`, { size: 11, color: C.faint, mono: true }));
  s.push(
    txt(sx + sw, GRID.strip.y + 24, 'now', { size: 11, color: C.faint, anchor: 'end', mono: true }),
  );
  s.push(
    txt(sx + sw / 2, GRID.strip.y + 24, 'gaps halve toward the present', {
      size: 11,
      color: C.faint,
      anchor: 'middle',
    }),
  );

  // --- gain panel
  s.push(panel(COL.x, GAIN.y, COL.w, GAIN.h));
  s.push(label(COL.x + 16, GAIN.y + 22, 'AUDIO GAIN'));
  s.push(
    txt(
      COL.x + COL.w - 16,
      GAIN.y + 22,
      `${cur.gain.toFixed(0)} dB   base ${cur.base.toFixed(0)}   +${cur.jump.toFixed(1)}`,
      { size: 12, color: cur.jump >= JOLT_GAIN_DB ? C.gain : C.dim, anchor: 'end', mono: true },
    ),
  );
  s.push(
    plot({
      y: GAIN.plot.y,
      h: GAIN.plot.h,
      lo: -70,
      hi: 0,
      color: C.gain,
      now,
      axis: ['-70', '0 dB'],
      marks: gainJolts,
      series: win.map((p) => ({ ms: p.ms, v: p.gain })),
      baseline: win.map((p) => ({ ms: p.ms, v: p.base })),
      threshold: win.map((p) => ({ ms: p.ms, v: p.base + JOLT_GAIN_DB })),
    }),
  );

  // --- colour panel
  s.push(panel(COL.x, CLR.y, COL.w, CLR.h));
  s.push(label(COL.x + 16, CLR.y + 22, 'COLOUR DELTA'));
  s.push(
    txt(COL.x + COL.w - 16, CLR.y + 22, `${(cur.color ?? 0).toFixed(3)}   thr ${JOLT_COLOR_DELTA}`, {
      size: 12,
      color: (cur.color ?? 0) >= JOLT_COLOR_DELTA ? C.color : C.dim,
      anchor: 'end',
      mono: true,
    }),
  );
  s.push(
    plot({
      y: CLR.plot.y,
      h: CLR.plot.h,
      lo: 0,
      hi: 0.6,
      color: C.color,
      now,
      axis: ['0', '0.6'],
      marks: colorJolts,
      series: win.map((p) => ({ ms: p.ms, v: p.color })),
      threshold: win.map((p) => ({ ms: p.ms, v: JOLT_COLOR_DELTA })),
    }),
  );

  // --- transcript panel
  s.push(panel(COL.x, TXT.y, COL.w, TXT.h));
  s.push(label(COL.x + 16, TXT.y + 22, 'GAME AUDIO TRANSCRIPT'));
  s.push(
    txt(COL.x + COL.w - 16, TXT.y + 22, 'whisper-tiny.en, offline', {
      size: 11,
      color: C.faint,
      anchor: 'end',
    }),
  );
  const heard = transcript.filter((c) => c.to > now - 14_000 && c.from <= now).slice(-3);
  let ty = TXT.y + 46;
  for (const c of heard) {
    const live = c.from <= now && c.to > now;
    for (const ln of wrap(c.text, COL.w - 90, 14, 0.52).slice(0, 2)) {
      if (ty > TXT.y + TXT.h - 8) break;
      s.push(txt(COL.x + 16, ty, clock(c.from), { size: 12, color: C.faint, mono: true }));
      s.push(txt(COL.x + 62, ty, ln, { size: 14, color: live ? C.ink : C.dim }));
      ty += 20;
    }
  }
  if (!heard.length) s.push(txt(COL.x + 16, TXT.y + 46, 'no speech', { size: 14, color: C.faint }));

  s.push('</svg>');
  return s.join('');
}

async function frame(now: number): Promise<Buffer> {
  let lastIdx = -1;
  for (let i = 0; i < vo.turns.length; i++) if (vo.turns[i].t <= now) lastIdx = i;
  const base = sharp(Buffer.from(frameSvg(now)));
  if (lastIdx >= 0 && gridFiles[lastIdx]) {
    base.composite([
      { input: await gridFor(lastIdx), top: GRID.img.y, left: COL.x + 2 },
    ]);
  }
  return base.raw().toBuffer();
}

// ---------------------------------------------------------------- run

async function main(): Promise<void> {
  const durationMs = LIMIT_S > 0 ? LIMIT_S * 1000 : steps[steps.length - 1].ms;
  const total = Math.floor((durationMs / 1000) * FPS);
  console.log(`[render] ${total} frames at ${FPS} fps -> ${DEST}`);

  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', `color=c=0x0e1013:s=${W}x${H}:r=${FPS}`,
      '-i', VIDEO,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
      '-filter_complex',
      `[0:v][1:v]overlay=${VID.x}:${VID.y}:shortest=1[a];[a][2:v]overlay=0:0:eof_action=endall[v]`,
      '-map', '[v]', '-map', '1:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-r', String(FPS), '-shortest', DEST,
    ],
    { stdio: ['pipe', 'inherit', 'pipe'] },
  );
  let err = '';
  ff.stderr.on('data', (d: Buffer) => {
    err += d.toString();
    if (err.length > 8000) err = err.slice(-8000);
  });
  const done = new Promise<number>((res) => ff.on('close', res));

  for (let i = 0; i < total; i++) {
    const now = (i / FPS) * 1000;
    const buf = await frame(now);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (FPS * 10) === 0) console.log(`[render] ${clock(now)}`);
  }
  ff.stdin.end();

  const code = await done;
  if (code !== 0) {
    console.error(err);
    process.exitCode = 1;
    return;
  }
  console.log(`[render] wrote ${DEST}`);
}

void main();
