import { describe, it, expect, vi, beforeEach } from 'vitest';

const capture = vi.fn();
vi.mock('../analytics', () => ({ capture: (...a: unknown[]) => capture(...a) }));
const importPngRemix = vi.fn();
vi.mock('./avatarStore', () => ({ importPngRemix: (...a: unknown[]) => importPngRemix(...a) }));

import { countBucket, importPngRemixTracked, pngRemixModelName } from './pngRemixImport';
import { PngRemixError } from '../../shared/pngremix/pngRemix';

beforeEach(() => {
  capture.mockReset();
  importPngRemix.mockReset();
});

describe('pngRemixImport', () => {
  it('names the model from the file stem', () => {
    expect(pngRemixModelName('/Users/x/Models/Pickles.pngRemix')).toBe('Pickles');
    expect(pngRemixModelName('C:\\m\\a\u0007b.PNGREMIX')).toBe('ab');
    expect(pngRemixModelName(null)).toBe('PNGTuber model');
    expect(pngRemixModelName('.pngRemix')).toBe('PNGTuber model');
  });

  it('buckets counts', () => {
    expect([0, 1, 3, 20, 21, 100, 101].map(countBucket)).toEqual(['0', '1', '2-5', '6-20', '21-50', '51-100', '100+']);
  });

  it('captures shape only on success', async () => {
    importPngRemix.mockResolvedValue({
      manifest: { emotions: { happy: 'Smug' } },
      parsed: {
        spec: { source: { generation: 'v14' }, layers: [{ kind: 'sprite' }, { kind: 'appendage' }], states: [{}, {}], images: [{}] },
        skippedImages: 0,
      },
    });
    await importPngRemixTracked('c1', new Uint8Array(10), 'Secret Name.pngRemix');
    expect(importPngRemix).toHaveBeenCalledWith('c1', expect.any(Uint8Array), 'Secret Name');
    const [event, props] = capture.mock.calls[0]!;
    expect(event).toBe('seilink_pngremix_import');
    expect(props).toMatchObject({ result: 'ok', generation: 'v14', layers: '2-5', states: '2-5', images: '1', emotions_mapped: 1, appendages: true });
    expect(JSON.stringify(props)).not.toMatch(/Secret|Smug/);
  });

  it('captures a closed reason on failure and rethrows', async () => {
    importPngRemix.mockRejectedValueOnce(new PngRemixError('unsafe', 'object carries a script'));
    await expect(importPngRemixTracked('c1', new Uint8Array(10), 'a.pngRemix')).rejects.toBeInstanceOf(PngRemixError);
    expect(capture.mock.calls[0]![1]).toMatchObject({ result: 'fail', reason: 'unsafe' });
    importPngRemix.mockRejectedValueOnce(new Error('EACCES /Users/someone/path'));
    await expect(importPngRemixTracked('c1', new Uint8Array(10), 'a.pngRemix')).rejects.toThrow();
    expect(capture.mock.calls[1]![1]).toEqual({ result: 'fail', reason: 'store_failed', mb: expect.any(Number) });
  });
});
