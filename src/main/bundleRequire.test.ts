import { afterEach, describe, expect, it } from 'vitest';
import { bundleRequire } from './bundleRequire';

const origCwd = process.cwd();

describe('bundleRequire', () => {
  afterEach(() => process.chdir(origCwd));

  it('resolves node_modules relative to the bundle, not the working directory', () => {
    // A packaged app launched from Finder runs with cwd `/`; the old
    // `createRequire(process.cwd())` fallback lost every module there.
    process.chdir('/');
    const req = bundleRequire();
    expect(() => req.resolve('sherpa-onnx-node')).not.toThrow();
    expect(() => req.resolve('prismarine-viewer/package.json')).not.toThrow();
    expect(() => req.resolve('img2skin/package.json')).not.toThrow();
  });
});
