/**
 * macOS Vision screen-text driver (260803) — main-process host for the bundled
 * helper (native/mac-ocr, shipped as Resources/mac-ocr/sei-mac-ocr).
 *
 * Same shape as audioTap.ts, and for the same reason: the capability is a
 * platform framework with no browser equivalent, so a small Swift binary is
 * spawned and spoken to over stdio. Here it replaces tesseract.js, which stays
 * as the fallback everywhere Vision is not available.
 *
 * Why replace it, measured on the Valorant test clip (four frames, Tesseract at
 * the 2x upscale it needs against Vision at native resolution):
 *
 *   0:40  tesseract  "A Site ne i 410 (OPERATOR 100 1"       ~1000 ms
 *         vision     "A Site / 1:17 / SIGNATURE ABILITY        ~100 ms
 *                     CHARGED / 410 / 2,150"
 *
 * Whole phrases instead of fragments, line structure preserved, and an order of
 * magnitude faster.
 *
 * Everything degrades, nothing blocks: a missing binary, an old macOS, a crash
 * mid-session or a slow frame all end as "no reading this time", which the
 * renderer already treats as the no-text case.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { OcrLine } from '../../shared/backseatIpc';

/** How long to wait for the helper's "ready" line. It warms the Vision engine
 *  before answering, which is most of this; a hang past it is a broken binary. */
const READY_TIMEOUT_MS = 10_000;

/** A recognition that has not answered by now is never going to. Vision runs at
 *  60-110 ms on a 720p frame, so this is two orders of margin. */
const RECOGNIZE_TIMEOUT_MS = 5_000;

/** Refuse frames past this rather than write a length header the helper will
 *  treat as a desynchronised stream. A 720p JPEG is ~100 KB. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

interface Pending {
  resolve: (lines: OcrLine[] | null) => void;
  timer: NodeJS.Timeout;
}

let proc: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<boolean> | null = null;
/** Single-flight by construction: the renderer sends the next frame only after
 *  reading a reply, and the helper answers in order. */
let pending: Pending | null = null;
let stdoutBuf = '';

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mac-ocr', 'sei-mac-ocr')
    : path.join(app.getAppPath(), 'resources', 'mac-ocr', 'sei-mac-ocr');
}

/** Whether the native path can run here at all, without starting it. */
export async function visionOcrAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await access(helperPath());
    return true;
  } catch {
    return false;
  }
}

function settle(lines: OcrLine[] | null): void {
  const p = pending;
  pending = null;
  if (!p) return;
  clearTimeout(p.timer);
  p.resolve(lines);
}

function onLine(line: string): void {
  const text = line.trim();
  if (!text) return;
  if (text.startsWith('ready')) return; // consumed by start()
  try {
    const parsed = JSON.parse(text) as { lines?: Array<{ t?: unknown; c?: unknown }> };
    const out: OcrLine[] = [];
    for (const l of parsed.lines ?? []) {
      if (typeof l?.t === 'string' && typeof l?.c === 'number') {
        out.push({ text: l.t, confidence: l.c });
      }
    }
    settle(out);
  } catch {
    // A malformed reply must still release the caller, or the renderer's
    // single-flight guard never opens again.
    settle(null);
  }
}

/**
 * Spawn the helper and wait for it to warm the Vision engine. Idempotent, and
 * safe to race: concurrent callers share one start.
 */
export async function startVisionOcr(language?: string): Promise<boolean> {
  if (proc) return true;
  if (starting) return starting;
  starting = (async () => {
    if (!(await visionOcrAvailable())) return false;
    return await new Promise<boolean>((resolve) => {
      let p: ChildProcessWithoutNullStreams;
      try {
        // The language tag is best-effort on both sides: the helper falls back
        // to en-US for anything Vision does not support, rather than failing.
        const args = language ? ['--lang', language] : [];
        p = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve(false);
        return;
      }
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve(false);
      }, READY_TIMEOUT_MS);

      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!ready && line.startsWith('ready')) {
            ready = true;
            clearTimeout(timer);
            proc = p;
            console.log(`[sei] backseat: vision ocr ${line.trim()}`);
            resolve(true);
            continue;
          }
          onLine(line);
        }
      });
      p.stderr.on('data', (d: Buffer) => {
        const s = String(d).trim();
        if (s) console.warn(`[sei] backseat: vision ocr: ${s}`);
      });
      const die = (): void => {
        clearTimeout(timer);
        if (proc === p) proc = null;
        stdoutBuf = '';
        // Release anything in flight so the renderer is not left waiting on a
        // process that no longer exists.
        settle(null);
        if (!ready) resolve(false);
      };
      p.on('error', die);
      p.on('exit', die);
    });
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * Read the text off one JPEG frame. Returns null when the native path is not
 * running, is already busy, or did not answer, and the caller treats that
 * exactly like an empty reading.
 */
export async function recognizeFrame(jpeg: Uint8Array): Promise<OcrLine[] | null> {
  const p = proc;
  if (!p || pending) return null;
  if (!jpeg.byteLength || jpeg.byteLength > MAX_FRAME_BYTES) return null;
  return await new Promise<OcrLine[] | null>((resolve) => {
    const timer = setTimeout(() => {
      // The helper answers strictly in order, so a frame that never came back
      // means the stream is desynchronised and the process has to go.
      stopVisionOcr();
      resolve(null);
    }, RECOGNIZE_TIMEOUT_MS);
    pending = { resolve, timer };
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(jpeg.byteLength, 0);
    try {
      p.stdin.write(header);
      p.stdin.write(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
    } catch {
      settle(null);
    }
  });
}

export function stopVisionOcr(): void {
  const p = proc;
  proc = null;
  stdoutBuf = '';
  settle(null);
  if (!p) return;
  try {
    p.stdin.end();
    p.kill();
  } catch {
    /* already gone */
  }
}
