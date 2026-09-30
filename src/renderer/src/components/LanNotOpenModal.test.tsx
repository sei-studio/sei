/**
 * LanNotOpenModal version hint (260929): the "up to" ceiling is the newest
 * version Sei can JOIN (26.3 on the shipped tables), not the setup wizard's
 * target (26.1), which is what the hint used to name.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { supportedVersions } from 'minecraft-protocol/src/version.js';

(globalThis as unknown as { window: unknown }).window = { sei: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
const { LanNotOpenModal } = await import('./LanNotOpenModal');
const { MC_NEWEST_JOINABLE, MC_RECOMMENDED } = await import('../lib/mcVersions');

describe('LanNotOpenModal', () => {
  it('names the newest joinable version as the ceiling', () => {
    const newest = supportedVersions[supportedVersions.length - 1];
    expect(MC_NEWEST_JOINABLE).toBe(newest);
    expect(MC_NEWEST_JOINABLE).not.toBe(MC_RECOMMENDED);
    const html = renderToStaticMarkup(React.createElement(LanNotOpenModal, { characterId: 'c1' }));
    expect(html).toContain(`Sei supports versions up to ${newest}.`);
  });
});
