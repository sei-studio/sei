/**
 * macOS system-audio tap (260728) — main-process driver for the bundled
 * ScreenCaptureKit helper (native/mac-audio-tap, shipped as
 * Resources/audio-tap/sei-audio-tap).
 *
 * Chromium's `audio: 'loopback'` is Windows-only (measured — see
 * captureController.ts), so on macOS the overlay renderer asks main to start
 * this tap instead. Main spawns the helper, re-aligns its raw Float32 stream on
 * frame boundaries, and relays PCM chunks to the overlay renderer over
 * `backseat:pcm`. The renderer's pipeline is then identical on both platforms;
 * only the source differs.
 *
 * Everything degrades, nothing blocks: a missing binary, an old macOS, a TCC
 * refusal, or a crash mid-session all end as "no PCM flows", which the renderer
 * already treats as the video-only case.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { IpcChannel } from '../../shared/ipc';
import { TAP_SAMPLE_RATE, TAP_CHANNELS } from '../../shared/backseatIpc';

/** How long to wait for the helper's "ready" line before calling it dead.
 *  SCK setup is normally well under a second; a hang here is a TCC refusal. */
const READY_TIMEOUT_MS = 5_000;

/** Relay batch size: ~50 ms of 48 kHz stereo Float32. Batching keeps the IPC
 *  rate at ~20 msg/s instead of one per pipe read. */
const BATCH_BYTES = Math.floor((TAP_SAMPLE_RATE * TAP_CHANNELS * 4) / 20);
/** Bytes per PCM frame (one sample for every channel). Chunks are re-aligned
 *  to this so the renderer can always read whole frames. */
const FRAME_BYTES = TAP_CHANNELS * 4;

let proc: ChildProcessWithoutNullStreams | null = null;

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'audio-tap', 'sei-audio-tap')
    : path.join(app.getAppPath(), 'resources', 'audio-tap', 'sei-audio-tap');
}

/**
 * Start the tap and begin relaying PCM to the overlay. Resolves the stream
 * format once audio actually flows, or null when the tap cannot run here —
 * the renderer treats null as "no system audio on this machine".
 */
export async function startAudioTap(
  sender: Electron.WebContents,
): Promise<{ sampleRate: number; channels: number } | null> {
  if (process.platform !== 'darwin') return null;
  stopAudioTap();

  const bin = helperPath();
  try {
    await access(bin);
  } catch {
    // Dev machine without `npm run build:audiotap`, or a broken package.
    console.warn('[sei] backseat: audio tap binary missing, running without system audio');
    return null;
  }

  // Exclude Sei's own audio so the companion's TTS voice cannot loop back into
  // its own transcript. The dev id covers `npm run dev`, where Electron runs
  // under its default bundle identifier.
  const excludes = ['--exclude', 'com.sei.app', '--exclude', 'com.github.Electron'];

  return await new Promise((resolve) => {
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(bin, excludes, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    proc = p;
    let ready = false;
    const readyTimer = setTimeout(() => {
      if (!ready) {
        // No audio ever flowed. Kill it and let the session run video-only.
        stopAudioTap();
        resolve(null);
      }
    }, READY_TIMEOUT_MS);

    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (line: string) => {
      // One JSON object per line; "ready" fires once audio flows.
      if (!ready && line.includes('"ready"')) {
        ready = true;
        clearTimeout(readyTimer);
        resolve({ sampleRate: TAP_SAMPLE_RATE, channels: TAP_CHANNELS });
      }
      if (line.includes('"error"')) {
        console.warn(`[sei] backseat audio tap: ${line.trim()}`);
      }
    });

    // Re-align on frame boundaries and batch before relaying. The helper's
    // format is fixed (48 kHz stereo f32le), so alignment is pure arithmetic.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let carry: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % FRAME_BYTES);
      carry = buf.subarray(usable);
      if (!usable) return;
      pending.push(buf.subarray(0, usable));
      pendingBytes += usable;
      if (pendingBytes >= BATCH_BYTES) {
        const batch = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        // Copy into a fresh ArrayBuffer: Buffer pools share backing stores,
        // and structured clone would otherwise ship the whole pool slab.
        //
        // 260803: back to whichever renderer ASKED for the tap, rather than to
        // a named overlay window that no longer exists. The requester is by
        // definition the one running capture.
        if (!sender.isDestroyed()) {
          sender.send(IpcChannel.backseat.pcm, new Uint8Array(batch).buffer);
        }
      }
    });

    p.on('exit', () => {
      if (proc === p) proc = null;
      if (!ready) {
        clearTimeout(readyTimer);
        resolve(null);
      }
    });
    p.on('error', () => {
      if (proc === p) proc = null;
      if (!ready) {
        clearTimeout(readyTimer);
        resolve(null);
      }
    });
  });
}

export function stopAudioTap(): void {
  const p = proc;
  proc = null;
  if (!p) return;
  try {
    // Closing stdin is the documented shutdown (the helper's orphan guard);
    // the kill is the backstop for a wedged process.
    p.stdin.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }, 500);
}
