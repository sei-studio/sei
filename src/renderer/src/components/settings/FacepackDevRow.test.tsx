/**
 * 261028 facepack pilot: the About row renders nothing unless main reports
 * the dev flag on, and then carries each pack's attribution.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { FacepackDevRowView } = await import('./FacepackDevRow');

const html = (info: Parameters<typeof FacepackDevRowView>[0]['info']) =>
  renderToStaticMarkup(<FacepackDevRowView info={info} onOpen={() => {}} />);

describe('FacepackDevRowView', () => {
  it('renders nothing with the flag off or unknown', () => {
    expect(html(null)).toBe('');
    expect(html({ enabled: false, packs: [], baseUrl: null })).toBe('');
  });
  it('shows the preview button and each pack credit with the flag on', () => {
    const out = html({
      enabled: true,
      baseUrl: null,
      packs: [
        { id: 'lyra', character: 'Lyra', bytes: 1, attribution: ['Frames by THA3 (CC BY 4.0).', 'Upscaled.'] },
        { id: 'sui', character: 'Sui', bytes: 1, attribution: [] },
      ],
    });
    expect(out).toContain('Face preview (dev)');
    expect(out).toContain('Lyra face: Frames by THA3 (CC BY 4.0). Upscaled.');
    expect(out).not.toContain('Sui face');
  });
});
