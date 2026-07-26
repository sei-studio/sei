/**
 * sttArbiter (260724) — the cloud/local race policy behind call dictation.
 *
 * Pins: cloud-first when cloud is faster; local + bounded grace when local
 * finishes first; cloud null/reject always degrades to local; cloud '' is
 * trusted (Scribe judged non-speech); no cloud configured → pure local
 * passthrough.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSttArbiter } from './sttArbiter';

const AUDIO = new Float32Array(1600);

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('createSttArbiter', () => {
  it('no cloud configured → local result, untouched', async () => {
    const t = createSttArbiter({ local: async () => 'local words', cloud: null, graceMs: 50 });
    await expect(t(AUDIO)).resolves.toBe('local words');
  });

  it('cloud faster than local → cloud wins', async () => {
    const t = createSttArbiter({
      local: () => after(80, 'local words'),
      cloud: () => after(10, 'cloud words'),
      graceMs: 50,
    });
    await expect(t(AUDIO)).resolves.toBe('cloud words');
  });

  it('local first, cloud lands inside the grace window → cloud wins', async () => {
    const t = createSttArbiter({
      local: () => after(10, 'local words'),
      cloud: () => after(40, 'cloud words'),
      graceMs: 100,
    });
    await expect(t(AUDIO)).resolves.toBe('cloud words');
  });

  it('local first, cloud misses the grace window → local, without waiting for cloud', async () => {
    const t = createSttArbiter({
      local: () => after(10, 'local words'),
      cloud: () => after(800, 'too late'),
      graceMs: 40,
    });
    const started = Date.now();
    await expect(t(AUDIO)).resolves.toBe('local words');
    // Well before the 800ms cloud pass — grace bounded the wait.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('cloud unavailable (null) → local, immediately once local is done', async () => {
    const t = createSttArbiter({
      local: () => after(20, 'local words'),
      cloud: async () => null,
      graceMs: 5_000, // must NOT be waited out on a resolved-null cloud
    });
    const started = Date.now();
    await expect(t(AUDIO)).resolves.toBe('local words');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('cloud rejection is contained → local', async () => {
    const t = createSttArbiter({
      local: () => after(10, 'local words'),
      cloud: () => Promise.reject(new Error('transport bug')),
      graceMs: 50,
    });
    await expect(t(AUDIO)).resolves.toBe('local words');
  });

  it("empty local result waits for cloud past the grace window (the laughter path)", async () => {
    // tiny noise-filters a laugh to '' almost instantly; Scribe comes back
    // with "(laughs)" long after graceMs. '' has no latency value, so the
    // arbiter must wait.
    const t = createSttArbiter({
      local: () => after(5, ''),
      cloud: () => after(200, 'haha'),
      graceMs: 40,
    });
    await expect(t(AUDIO)).resolves.toBe('haha');
  });

  it('empty local + failed cloud still resolves empty (utterance dropped as before)', async () => {
    const t = createSttArbiter({
      local: () => after(5, ''),
      cloud: () => after(50, null),
      graceMs: 40,
    });
    await expect(t(AUDIO)).resolves.toBe('');
  });

  it("cloud '' is trusted over a local hallucination", async () => {
    const t = createSttArbiter({
      local: () => after(30, 'thanks for watching!'),
      cloud: () => after(5, ''),
      graceMs: 50,
    });
    await expect(t(AUDIO)).resolves.toBe('');
  });

  it('both transcribers receive the same audio', async () => {
    const local = vi.fn(async () => 'l');
    const cloud = vi.fn(async () => 'c');
    const t = createSttArbiter({ local, cloud, graceMs: 50 });
    await t(AUDIO);
    expect(local).toHaveBeenCalledWith(AUDIO);
    expect(cloud).toHaveBeenCalledWith(AUDIO);
  });
});

describe("createSttArbiter cloud-only mode (local: null — the 'none' policy)", () => {
  it('cloud result is delivered as-is, no failure reported', async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: () => after(10, 'cloud words'),
      graceMs: 50,
      cloudTimeoutMs: 500,
      onCloudFailure,
    });
    await expect(t(AUDIO)).resolves.toBe('cloud words');
    expect(onCloudFailure).not.toHaveBeenCalled();
  });

  it("cloud '' stays trusted non-speech — dropped upstream, NOT a failure", async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: () => after(5, ''),
      graceMs: 50,
      cloudTimeoutMs: 500,
      onCloudFailure,
    });
    await expect(t(AUDIO)).resolves.toBe('');
    expect(onCloudFailure).not.toHaveBeenCalled();
  });

  it("cloud null (unavailable) → '' and onCloudFailure fires", async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: async () => null,
      graceMs: 50,
      cloudTimeoutMs: 500,
      onCloudFailure,
    });
    await expect(t(AUDIO)).resolves.toBe('');
    expect(onCloudFailure).toHaveBeenCalledTimes(1);
  });

  it("cloud rejection is contained → '' and onCloudFailure fires", async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: () => Promise.reject(new Error('transport bug')),
      graceMs: 50,
      cloudTimeoutMs: 500,
      onCloudFailure,
    });
    await expect(t(AUDIO)).resolves.toBe('');
    expect(onCloudFailure).toHaveBeenCalledTimes(1);
  });

  it('a hung cloud pass is bounded by cloudTimeoutMs, then counts as a failure', async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: () => after(5_000, 'way too late'),
      graceMs: 50,
      cloudTimeoutMs: 60,
      onCloudFailure,
    });
    const started = Date.now();
    await expect(t(AUDIO)).resolves.toBe('');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(onCloudFailure).toHaveBeenCalledTimes(1);
  });

  it("no cloud configured either → immediate '' + failure (nothing can transcribe)", async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({ local: null, cloud: null, graceMs: 50, onCloudFailure });
    await expect(t(AUDIO)).resolves.toBe('');
    expect(onCloudFailure).toHaveBeenCalledTimes(1);
  });

  it('failure fires per failed utterance (once-per-call gating is the caller’s)', async () => {
    const onCloudFailure = vi.fn();
    const t = createSttArbiter({
      local: null,
      cloud: async () => null,
      graceMs: 50,
      cloudTimeoutMs: 500,
      onCloudFailure,
    });
    await t(AUDIO);
    await t(AUDIO);
    expect(onCloudFailure).toHaveBeenCalledTimes(2);
  });
});
