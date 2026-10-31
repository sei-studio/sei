import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SAFE_MODE_UPDATE_CHANNELS } from './safeMode';
import { IpcChannel } from '../shared/ipc';

describe('safe-mode preload', () => {
  it('imports nothing but electron (a sandboxed preload cannot load a shared chunk)', () => {
    const src = readFileSync(path.join(__dirname, 'safeMode.ts'), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['electron']);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('listens on exactly the updater push channels', () => {
    const a = IpcChannel.app;
    expect(Object.keys(SAFE_MODE_UPDATE_CHANNELS).sort()).toEqual(
      [a.updateChecking, a.updateNotAvailable, a.updateAvailable, a.updateProgress, a.updateDownloaded, a.updateError].sort(),
    );
  });
});
