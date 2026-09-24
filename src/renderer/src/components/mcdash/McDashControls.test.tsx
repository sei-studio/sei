/**
 * McDashStatusStrip (260909): the status row grows one vanilla window per
 * OTHER companion in the world, each a button that opens that companion's
 * chat; alone, it is the single "Status" strip it always was.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = { sei: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
  vi.doMock('../../lib/stores/useUiStore', () => ({
    useUiStore: Object.assign((selector: (s: { navigate: () => void }) => unknown) => selector({ navigate: vi.fn() }), { getState: () => ({ navigate: vi.fn() }) }),
  }));
});

describe('McDashStatusStrip', () => {
  it('alone: one Status window, no peers', async () => {
    const { McDashStatusStrip } = await import('./McDashControls');
    const html = renderToStaticMarkup(React.createElement(McDashStatusStrip, { activity: 'mining stone...', paused: false, name: 'Sui', companions: [] }));
    expect(html).toContain('>Status<');
    expect(html).toContain('Mining stone...');
    expect(html).not.toContain('statusPeer');
  });

  it('with company: named windows, a peer button per companion, ellipsis before their first snapshot', async () => {
    const { McDashStatusStrip } = await import('./McDashControls');
    const html = renderToStaticMarkup(
      React.createElement(McDashStatusStrip, {
        activity: 'mining stone...',
        paused: true,
        name: 'Sui',
        companions: [
          { id: 'b', name: 'Marv', activity: 'following you', paused: false },
          { id: 'c', name: null, activity: null, paused: false },
        ],
      }),
    );
    expect(html).toContain('>Sui<');
    expect(html).toContain('>Paused<');
    expect(html.match(/statusPeer/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Open Marv&#x27;s chat"');
    expect(html).toContain('Following you');
    expect(html).toContain('>Companion<');
    expect(html).toContain('>...<');
  });
});
