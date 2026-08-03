/**
 * Offline screen-text extraction (260802, moved to Vision 260803).
 *
 * Runs the SAME engine and the SAME shaping a live macOS session runs (the
 * bundled native/mac-ocr helper, then shapeScreenText from
 * src/renderer/src/lib/backseat/screenText.ts) over full-resolution frames
 * pulled from the clip at SCREEN_TEXT_INTERVAL_MS, and writes
 * <out>/screentext.json.
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
 * WHY VISION, AND WHY THE 2X UPSCALE IS GONE. The first version of this script
 * drove tesseract.js and had to pre-scale every frame 2x to get anything at
 * all, because HUD text at 720p is around 12 px tall. Measured against Vision
 * on the same four frames:
 *
 *   0:14  tesseract  "Orange 50 NG IN"
 *         vision     "B Orange / 5 / SPIKE PLANTED / 50 100 / 1,550"
 *   0:40  tesseract  "A Site ne i 410 (OPERATOR 100 1"
 *         vision     "A Site / 1:17 / SIGNATURE ABILITY CHARGED / 410 / 2,150"
 *   1:28  tesseract  "KILLED BY vio COMBAT 46 55 Team Clin In Deteader Side Spawn"
 *         vision     "Sova / KILLED BY / Sova / OUTGOING / 105 / COMBAT REPORT /
 *                     INCOMING / 46 / Karasu / In Defender Side Spawn Team /
 *                     (Eliminated) / 190 / KILLED / 146"
 *
 *   ~1000 ms/frame at 2x                  ~72 ms/frame at 1x
 *
 * Whole phrases instead of fragments, line structure preserved, and an order of
 * magnitude faster, so the upscale went away with the engine.
 *
 * macOS only, like the helper. Everywhere else the app falls back to
 * tesseract.js and this script has nothing to drive.
 *
 *   npx tsx scripts/backseat-ocr.ts [video] [--out DIR] [--force] [--limit N]
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTURE_H,
  CAPTURE_W,
  SCREEN_TEXT_INTERVAL_MS,
  TICK_SCREEN_TEXT_MAX_WORDS,
  type OcrLine,
} from '../src/shared/backseatIpc';
import { shapeScreenText } from '../src/renderer/src/lib/backseat/screenText';

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
const HELPER = path.resolve('resources/mac-ocr/sei-mac-ocr');

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Full-resolution frames at the OCR cadence, extracted once and reused. */
function prepare(): void {
  const marker = path.join(FRAMES, `.done-${SCREEN_TEXT_INTERVAL_MS}-native`);
  if (existsSync(marker)) return;
  mkdirSync(FRAMES, { recursive: true });
  const fps = 1000 / SCREEN_TEXT_INTERVAL_MS;
  console.log(`[ocr] extracting ${CAPTURE_W}x${CAPTURE_H} frames at ${fps} Hz`);
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', VIDEO,
      '-vf', `fps=${fps},scale=${CAPTURE_W}:${CAPTURE_H}:force_original_aspect_ratio=decrease:flags=lanczos`,
      // Quality 2 rather than the ring's 4: this frame is read for characters,
      // not shapes, and JPEG ringing around small glyphs is exactly what costs
      // a recognition its confidence. Matches SCREEN_TEXT_JPEG_QUALITY.
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
  /** Lines the engine returned at all, before any filtering. */
  raw: number;
  /** Words that survived into `text`. */
  kept: number;
  /** Mean confidence of the lines that survived, for judging the engine. */
  confidence: number;
  /** Recognition time in the helper, milliseconds. */
  ms: number;
}

/**
 * The helper's stdio protocol, driven the same way src/main/backseat/visionOcr.ts
 * drives it: a 4-byte big-endian length then the JPEG, one newline of JSON back,
 * strictly one frame in flight.
 */
function openHelper(): {
  read: (jpeg: Buffer) => Promise<{ lines: OcrLine[]; ms: number }>;
  close: () => void;
} {
  const proc = spawn(HELPER, ['--lang', 'en'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const queue: Array<(v: { lines: OcrLine[]; ms: number }) => void> = [];
  let ready: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith('ready')) {
        ready?.();
        ready = null;
        continue;
      }
      const parsed = JSON.parse(line) as { lines: Array<{ t: string; c: number }>; ms: number };
      queue.shift()?.({
        lines: parsed.lines.map((l) => ({ text: l.t, confidence: l.c })),
        ms: parsed.ms,
      });
    }
  });
  return {
    read: async (jpeg) => {
      await readyPromise;
      return await new Promise((resolve) => {
        queue.push(resolve);
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(jpeg.length, 0);
        proc.stdin.write(header);
        proc.stdin.write(jpeg);
      });
    },
    close: () => {
      proc.stdin.end();
      proc.kill();
    },
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('[ocr] macOS only: this drives the bundled Vision helper.');
    process.exit(1);
  }
  if (!existsSync(HELPER)) {
    console.error(`[ocr] missing ${HELPER} — run: npm run build:macocr`);
    process.exit(1);
  }
  if (existsSync(DEST) && !flag('force')) {
    console.log(`[ocr] ${DEST} exists, nothing to do (pass --force to redo)`);
    return;
  }
  prepare();
  const files = readdirSync(FRAMES).filter((f) => f.endsWith('.jpg')).sort();
  const todo = LIMIT ? files.slice(0, LIMIT) : files;
  console.log(`[ocr] ${todo.length} frames`);

  const helper = openHelper();
  const readings: Reading[] = [];
  for (let i = 0; i < todo.length; i++) {
    // ffmpeg numbers from 1 and frame N covers [(N-1)*interval, N*interval).
    const t = i * SCREEN_TEXT_INTERVAL_MS;
    const { lines, ms } = await helper.read(readFileSync(path.join(FRAMES, todo[i])));
    const text = shapeScreenText(lines, TICK_SCREEN_TEXT_MAX_WORDS);
    const survivors = lines.filter((l) => text.includes(l.text.split(/\s+/)[0]));
    readings.push({
      t,
      text,
      raw: lines.length,
      kept: text ? text.split(/\s+/).length : 0,
      confidence: survivors.length
        ? Math.round(survivors.reduce((a, l) => a + l.confidence, 0) / survivors.length)
        : 0,
      ms,
    });
    console.log(`[ocr] ${clock(t)}  ${lines.length} lines  ${ms}ms  ${text ? text.slice(0, 110) : '-'}`);
  }
  helper.close();

  writeFileSync(
    DEST,
    JSON.stringify(
      {
        video: VIDEO,
        engine: 'macos-vision',
        intervalMs: SCREEN_TEXT_INTERVAL_MS,
        maxWords: TICK_SCREEN_TEXT_MAX_WORDS,
        readings,
      },
      null,
      1,
    ),
  );
  const withText = readings.filter((r) => r.text);
  console.log(
    `\n[ocr] ${readings.length} frames, ${withText.length} produced text ` +
      `(mean ${Math.round(withText.reduce((a, r) => a + r.kept, 0) / Math.max(1, withText.length))} words, ` +
      `mean confidence ${Math.round(withText.reduce((a, r) => a + r.confidence, 0) / Math.max(1, withText.length))}, ` +
      `mean ${Math.round(readings.reduce((a, r) => a + r.ms, 0) / Math.max(1, readings.length))} ms/frame)`,
  );
  console.log(`[ocr] -> ${DEST}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
