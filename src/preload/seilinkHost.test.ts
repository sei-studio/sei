import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SEILINK_HOST_PRELOAD_CHANNELS } from './seilinkHost';
import { SEILINK_HOST_CHANNELS } from '../shared/seilinkHostChannels';

describe('SeiLink room host preload', () => {
  it('imports nothing but electron (a sandboxed preload cannot load a shared chunk)', () => {
    const src = readFileSync(path.join(__dirname, 'seilinkHost.ts'), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['electron']);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('spells the same channels as the host process', () => {
    expect(SEILINK_HOST_PRELOAD_CHANNELS).toEqual(SEILINK_HOST_CHANNELS);
  });
});
