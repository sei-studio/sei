/**
 * 260817 (china-compat W10) — maia download source ordering.
 *
 * The W10 cloud-no-regression rule: a supported-region user's first chess
 * launch downloads from the ORIGINAL GitHub release URL first (byte-identical
 * pre-stream behavior); only a blocked-region verdict flips the R2 mirror to
 * the front. Pins the pure ordering helper so a refactor cannot silently make
 * the mirror primary for everyone again.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: (_k: string) => '/tmp/sei-modelstore-test' },
}));

import { modelUrlOrder, downloadModelFile, ModelDownloadError } from './modelStore';

const ORIGIN = 'https://github.com/sei-studio/cce-1/releases/download/model-v1/maia3-5m.onnx';
const MIRROR = 'https://dl.sei.gg/chess/maia3-5m.onnx';

describe('modelUrlOrder (W10)', () => {
  it('supported region (blocked=false): origin first, mirror as fallback', () => {
    expect(modelUrlOrder(false)).toEqual([ORIGIN, MIRROR]);
  });

  it('blocked region: mirror first, origin as fallback', () => {
    expect(modelUrlOrder(true)).toEqual([MIRROR, ORIGIN]);
  });
});

// ── 260929: timeout + retry ─────────────────────────────────────────────────
//
// The first-game model download used to be a bare fetch() with no timeout: a
// stalled connection left the board in "preparing" forever. These pin the
// budget: a silent source times out, the next attempt moves on, and a total
// failure throws a typed error the chess service can show and report.


const FAST = { connectTimeoutMs: 60, stallTimeoutMs: 60, attempts: 3, retryDelayMs: 0 };
const BYTES = 64;

function okResponse(chunks: Uint8Array[], opts?: { stallAfter?: number }): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (opts?.stallAfter !== undefined && i >= opts.stallAfter) {
        return new Promise(() => {}); // never delivers another byte
      }
      if (i < chunks.length) ctrl.enqueue(chunks[i++]);
      else ctrl.close();
      return undefined;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-length': String(BYTES) } });
}

function payload(): Uint8Array[] {
  return [new Uint8Array(BYTES / 2).fill(1), new Uint8Array(BYTES / 2).fill(2)];
}

describe('downloadModelFile (260929 timeout + retry)', () => {
  let dir: string;
  let target: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sei-model-dl-'));
    target = path.join(dir, 'model.onnx');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads a correctly sized file and reports progress up to 100', async () => {
    const progress: number[] = [];
    const fetchImpl = vi.fn(async () => okResponse(payload()));
    const out = await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: FAST,
      onProgress: (p) => progress.push(p),
    });
    expect(out).toBe(target);
    expect((await stat(target)).size).toBe(BYTES);
    expect(progress[progress.length - 1]).toBe(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a source that never answers and succeeds on the next one', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('dead')) return new Promise<Response>(() => {}); // ignores the signal on purpose
      return okResponse(payload());
    });
    await downloadModelFile(target, ['https://dead.example/m', 'https://live.example/m'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: FAST,
    });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://dead.example/m', 'https://live.example/m']);
    expect((await readFile(target)).length).toBe(BYTES);
  });

  it('treats a body that stops mid-way as a stall and retries', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? okResponse(payload(), { stallAfter: 1 }) : okResponse(payload());
    });
    await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: FAST,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await stat(target)).size).toBe(BYTES);
  });

  it('gives up after the attempt budget with a typed timeout error and no partial file', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const err = await downloadModelFile(target, ['https://a.example/m', 'https://b.example/m'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: FAST,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDownloadError);
    expect((err as ModelDownloadError).kind).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // a, b, a again
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(`${target}.download`)).rejects.toThrow();
  });

  it('classifies HTTP errors and size mismatches', async () => {
    const http = (await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: { ...FAST, attempts: 1 },
    }).catch((e: unknown) => e)) as ModelDownloadError;
    expect(http.kind).toBe('http');

    const short = (await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: (async () => okResponse([new Uint8Array(10)])) as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: { ...FAST, attempts: 1 },
    }).catch((e: unknown) => e)) as ModelDownloadError;
    expect(short.kind).toBe('size');
  });

  it('classifies a disk error without throwing out of the stream', async () => {
    // The temp path is a directory, so opening it for writing fails.
    await mkdir(`${target}.download`);
    const err = (await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: (async () => okResponse(payload())) as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: { ...FAST, attempts: 1 },
    }).catch((e: unknown) => e)) as ModelDownloadError;
    expect(err).toBeInstanceOf(ModelDownloadError);
    expect(err.kind).toBe('disk');
  });

  it('never touches an existing file at the target when every attempt fails', async () => {
    await writeFile(target, 'cached');
    const err = await downloadModelFile(target, ['https://a.example/m'], {
      fetchImpl: (async () => okResponse([new Uint8Array(10)])) as unknown as typeof fetch,
      expectedBytes: BYTES,
      timing: FAST,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDownloadError);
    expect(await readFile(target, 'utf8')).toBe('cached');
    await expect(stat(`${target}.download`)).rejects.toThrow();
  });
});
