/**
 * 261111 World egress: the card loads the small thumbnail (not the full
 * portrait), and a card without a thumbnail loads the full portrait.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowseEntry } from '@shared/ipc';

import { BrowseCard } from './BrowseCard';

function entry(over: Partial<BrowseEntry> = {}): BrowseEntry {
  return {
    id: 'c1',
    name: 'Nova',
    personaSnippet: '',
    creatorLabel: 'by someone',
    publicId: null,
    portraitUrl: 'https://x/portraits/o/c1.png?v=t1',
    thumbUrl: 'https://x/portraits/o/c1.thumb.webp?v=t1',
    skinUrl: null,
    updatedAt: 't1',
    inMyLibrary: false,
    addCount: null,
    ...over,
  };
}

const render = (e: BrowseEntry): string =>
  renderToStaticMarkup(React.createElement(BrowseCard, { entry: e, theme: 'dark', onOpen: () => {} }));

describe('BrowseCard art source', () => {
  it('loads the thumbnail, not the full portrait', () => {
    const html = render(entry());
    expect(html).toContain('src="https://x/portraits/o/c1.thumb.webp?v=t1"');
    expect(html).not.toContain('c1.png');
  });

  it('falls back to the full portrait when there is no thumbnail URL', () => {
    const html = render(entry({ thumbUrl: null }));
    expect(html).toContain('src="https://x/portraits/o/c1.png?v=t1"');
  });
});
