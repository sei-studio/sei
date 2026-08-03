/**
 * Offline screen-text extraction (260802).
 *
 * Runs the SAME engine and the SAME shaping the app runs (tesseract.js eng,
 * then shapeScreenText from src/renderer/src/lib/backseat/screenText.ts) over
 * full-resolution frames pulled from the clip at SCREEN_TEXT_INTERVAL_MS, and
 * writes <out>/screentext.json.
 *
 * Two jobs. It is the data behind the SCREEN TEXT panel in the review video, so
 * what that panel shows is what a live tick would actually have carried. And it
 * is the measurement that decides whether this is worth shipping at all: OCR
 * over a game frame is the adversarial case, and the honest way to find out
 * what it produces on Valorant is to look at what it produces on Valorant.
 *
 * Full resolution on purpose. The ring's cells are 602x336 and HUD text does
 * not survive that downscale, which is the whole reason the model cannot read
 * the screen off the grid in the first place.
 *
 * Settings were chosen by measurement, not by default (probe over four moments
 * of the Valorant clip, three scales x two page-segmentation modes):
 *
 *   PSM.AUTO at any scale ....... 0-11 words, usually nothing at all
 *   SPARSE_TEXT at 1x ........... 20-27 raw words, nothing legible survives
 *   SPARSE_TEXT at 2x ........... 24-40 raw, recovers "A Short", "Site", "550"
 *   SPARSE_TEXT at 3x ........... 41-47 raw, no better, ~2x the time
 *
 * AUTO fails because a game screen is not a page: there are no columns, no
 * reading order and no paragraphs, just labels scattered over a picture, and
 * asking for a document layout makes the engine discard most of them. The
 * upscale matters because HUD text at 720p is around 12 px tall, well under
 * what Tesseract reads comfortably.
 *
 *   npx tsx scripts/backseat-ocr.ts [video] [--out DIR] [--force] [--limit N]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTURE_H,
  CAPTURE_W,
  SCREEN_TEXT_INTERVAL_MS,
  SCREEN_TEXT_SCALE,
  TICK_SCREEN_TEXT_MAX_WORDS,
} from '../src/shared/backseatIpc';
import { shapeScreenText, type OcrWord } from '../src/renderer/src/lib/backseat/screenText';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const VIDEO = path.resolve(positional[0] ?? path.join(os.homedir(), 'Downloads', 'valorant-clips.mp4'));
const OUT = path.resolve(opt('out', path.join('.backseat-sim', path.parse(VIDEO).name)));
const FRAMES = path.join(OUT, 'prep', 'ocr');
const DEST = path.join(OUT, 'screentext.json');
const LIMIT = Number(opt('limit', '0'));

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Full-resolution frames at the OCR cadence, extracted once and reused. */
function prepare(): void {
  const marker = path.join(FRAMES, `.done-${SCREEN_TEXT_INTERVAL_MS}-${SCREEN_TEXT_SCALE}`);
  if (existsSync(marker)) return;
  mkdirSync(FRAMES, { recursive: true });
  const fps = 1000 / SCREEN_TEXT_INTERVAL_MS;
  const w = CAPTURE_W * SCREEN_TEXT_SCALE;
  const h = CAPTURE_H * SCREEN_TEXT_SCALE;
  console.log(`[ocr] extracting ${w}x${h} frames at ${fps} Hz`);
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', VIDEO,
      // lanczos, not the default bilinear: the upscale exists to give the engine
      // more glyph to work with, and a soft interpolation gives it more blur.
      '-vf', `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
      // Quality 2 rather than the ring's 4: this frame is read for characters,
      // not shapes, and JPEG ringing around small glyphs is exactly what costs
      // an OCR pass its confidence.
      '-q:v', '2',
      path.join(FRAMES, '%06d.jpg'),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  writeFileSync(marker, '');
}

interface Reading {
  /** Milliseconds into the clip. */
  t: number;
  /** What a tick would carry: confidence-filtered, junk-stripped, word-capped. */
  text: string;
  /** Words the engine returned at all, before any filtering. */
  raw: number;
  /** Words that survived into `text`, before the cap. */
  kept: number;
  /** Mean confidence of the surviving words, for judging the engine. */
  confidence: number;
}

async function main(): Promise<void> {
  if (existsSync(DEST) && !flag('force')) {
    console.log(`[ocr] ${DEST} exists, nothing to do (pass --force to redo)`);
    return;
  }
  prepare();
  const files = readdirSync(FRAMES).filter((f) => f.endsWith('.jpg')).sort();
  const todo = LIMIT ? files.slice(0, LIMIT) : files;
  console.log(`[ocr] ${todo.length} frames`);

  const { createWorker, PSM } = await import('tesseract.js');
  // cachePath keeps the ~4 MB eng.traineddata download inside the run's prep
  // directory. Left to itself Tesseract drops it in the process cwd, which here
  // is the repo root.
  const worker = await createWorker('eng', undefined, { cachePath: path.join(OUT, 'prep') });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    // Without this the engine guesses the DPI from the image and lands anywhere
    // from 286 to 663 across frames of the same clip, which changes how it
    // segments identical text.
    user_defined_dpi: '300',
  });

  const readings: Reading[] = [];
  for (let i = 0; i < todo.length; i++) {
    // ffmpeg numbers from 1 and frame N covers [(N-1)*interval, N*interval).
    const t = i * SCREEN_TEXT_INTERVAL_MS;
    const { data } = await worker.recognize(
      path.join(FRAMES, todo[i]),
      {},
      { blocks: true, text: false },
    );
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          for (const w of l.words) words.push({ text: w.text, confidence: w.confidence });
        }
      }
    }
    const text = shapeScreenText(words, TICK_SCREEN_TEXT_MAX_WORDS);
    const survivors = words.filter((w) => text.includes(w.text));
    readings.push({
      t,
      text,
      raw: words.length,
      kept: text ? text.split(/\s+/).length : 0,
      confidence: survivors.length
        ? Math.round(survivors.reduce((a, w) => a + w.confidence, 0) / survivors.length)
        : 0,
    });
    console.log(`[ocr] ${clock(t)}  ${words.length}w raw  ${text ? text.slice(0, 110) : '-'}`);
  }
  await worker.terminate();

  writeFileSync(
    DEST,
    JSON.stringify(
      { video: VIDEO, intervalMs: SCREEN_TEXT_INTERVAL_MS, maxWords: TICK_SCREEN_TEXT_MAX_WORDS, readings },
      null,
      1,
    ),
  );
  const withText = readings.filter((r) => r.text);
  console.log(
    `\n[ocr] ${readings.length} frames, ${withText.length} produced text ` +
      `(mean ${Math.round(withText.reduce((a, r) => a + r.kept, 0) / Math.max(1, withText.length))} words, ` +
      `mean confidence ${Math.round(withText.reduce((a, r) => a + r.confidence, 0) / Math.max(1, withText.length))})`,
  );
  console.log(`[ocr] -> ${DEST}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
