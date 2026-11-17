import { describe, expect, it, vi } from 'vitest';

vi.mock('../ipcClient', () => ({ sei: { avatarGet: vi.fn(async () => null), facepackForCharacter: vi.fn(async () => null) } }));
vi.mock('./portraitCutout', () => ({ loadCutout: vi.fn(async () => ({ src: 'blob:x', aspect: 0.67, method: 'vignette' })) }));

import { uploadedLookBlock, WORLDLINK_UPLOADED_LOOKS, worldlinkCustomImage, worldlinkLookBlock } from './uploadedLooks';
import { sei } from '../ipcClient';

const uploaded = { origin: 'uploaded' as const, figure: false };

describe('WorldLink uploaded looks (261116)', () => {
  it('ships off: every look moves in', () => {
    expect(WORLDLINK_UPLOADED_LOOKS).toBe('all');
    expect(uploadedLookBlock('all', { ...uploaded, cutout: 'vignette' })).toBe('none');
  });

  it("'clean_cutout' keeps out only an uploaded picture that cannot be cut out", () => {
    expect(uploadedLookBlock('clean_cutout', { ...uploaded, cutout: 'vignette' })).toBe('busy_background');
    expect(uploadedLookBlock('clean_cutout', { ...uploaded, cutout: 'key' })).toBe('none');
    expect(uploadedLookBlock('clean_cutout', { ...uploaded, cutout: null })).toBe('none');
  });

  it("'sei_looks' keeps out every uploaded picture without a face set or avatar", () => {
    expect(uploadedLookBlock('sei_looks', { ...uploaded, cutout: 'key' })).toBe('uploaded');
    expect(uploadedLookBlock('sei_looks', { ...uploaded, figure: true, cutout: null })).toBe('none');
    expect(uploadedLookBlock('sei_looks', { origin: 'generated', figure: false, cutout: null })).toBe('none');
  });

  it('a face set or avatar always lets her in (WorldLink does not draw the picture)', () => {
    expect(uploadedLookBlock('clean_cutout', { ...uploaded, figure: true, cutout: 'vignette' })).toBe('none');
  });

  it('reads nothing under the default policy', async () => {
    const aria = { id: 'a', kind: 'custom' as const, is_default: false, metadata: {}, portrait_image: 'p.png' };
    expect(await worldlinkLookBlock(aria)).toBe('none');
    expect(sei.avatarGet).not.toHaveBeenCalled();
  });

  it('judges an uploaded picture by its cut-out under clean_cutout', async () => {
    const aria = {
      id: 'b',
      kind: 'custom' as const,
      is_default: false,
      metadata: { portrait_active: 'v1.png', portrait_versions: [{ file: 'v1.png', source: 'upload', created_at: '2026-10-10T00:00:00Z' }] },
      portrait_image: 'https://example.invalid/aria.png',
    };
    expect(await worldlinkLookBlock(aria, 'clean_cutout')).toBe('busy_background');
    const sui = { ...aria, id: 'c', is_default: true };
    expect(await worldlinkLookBlock(sui, 'clean_cutout')).toBe('none');
  });

  it('flags a custom uploaded picture for the custom-image line (261118), never Sei-made looks', async () => {
    const versions = (source: 'upload' | 'regen') => ({
      portrait_active: 'v1.png',
      portrait_versions: [{ file: 'v1.png', source, created_at: '2026-10-10T00:00:00Z' }],
    });
    const aria = { id: 'd', kind: 'custom' as const, is_default: false, metadata: versions('upload'), portrait_image: 'https://example.invalid/aria.png' };
    expect(await worldlinkCustomImage(aria)).toBe(true);
    expect(await worldlinkCustomImage({ ...aria, id: 'e', metadata: versions('regen') })).toBe(false);
    expect(await worldlinkCustomImage({ ...aria, id: 'f', is_default: true })).toBe(false);
    expect(await worldlinkCustomImage({ ...aria, id: 'g', kind: 'unique' as const })).toBe(false);
    // An imported avatar or a face set: WorldLink does not draw the picture.
    vi.mocked(sei.facepackForCharacter!).mockResolvedValueOnce({} as never);
    expect(await worldlinkCustomImage({ ...aria, id: 'h' })).toBe(false);
  });
});
