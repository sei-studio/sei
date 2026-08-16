/**
 * 260817 (china-compat W10) — maia download source ordering.
 *
 * The W10 cloud-no-regression rule: a supported-region user's first chess
 * launch downloads from the ORIGINAL GitHub release URL first (byte-identical
 * pre-stream behavior); only a blocked-region verdict flips the R2 mirror to
 * the front. Pins the pure ordering helper so a refactor cannot silently make
 * the mirror primary for everyone again.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (_k: string) => '/tmp/sei-modelstore-test' },
}));

import { modelUrlOrder } from './modelStore';

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
