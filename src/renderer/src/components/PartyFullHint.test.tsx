/**
 * 261124: every surface that says the party is full carries Free a slot, and
 * the picker lists the party (as the rail counts it) with the copy saying
 * nothing changes until Unbind is confirmed. Copy is in every dictionary.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: { track: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
};
// The picker's avatar palette reads the theme from <html data-scheme>.
(globalThis as unknown as { document: unknown }).document = {
  documentElement: { getAttribute: () => null },
};

const { PartyFullHint, FreeSlotButton, FreeSlotPickerView, partyMembers } = await import('./PartyFullHint');
const { Banner } = await import('./Banner');
const { LocalImportRowView } = await import('./settings/LocalImportRow');
const { ImportLocalProfileModalView } = await import('./ImportLocalProfileModal');
const { DICTIONARIES } = await import('../lib/i18n');
const { FREE_A_SLOT, PARTY_FULL_HINT } = await import('../lib/partyFull');

const noop = (): void => undefined;

function char(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'custom',
    public_id: null,
    name,
    persona: { source: '', expanded: '' },
    is_default: false,
    description: null,
    shared: false,
    slug: null,
    metadata: {},
    created: '2026-11-01T00:00:00.000Z',
    last_launched: null,
    last_chatted: null,
    playtime_ms: 0,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner: null,
    ...extra,
  };
}

const fullPeek = {
  migratableCharacterIds: ['a', 'b'],
  memoryOnlyCharacterIds: [],
  mcUsername: null,
  preferredName: null,
  hasData: true,
  hasCompanionData: true,
  untouchedSeedIds: [] as string[],
  party: { count: 3, incoming: 2, limit: 4, fits: false },
};

describe('PartyFullHint', () => {
  it('one line: the party is full, unbind someone, and Free a slot', () => {
    const html = renderToStaticMarkup(<PartyFullHint surface="invite" />);
    expect(html).toContain('Your party is full. Unbind a companion to make room.');
    expect(html).toContain('data-free-slot="invite"');
    expect(html).toContain('>Free a slot<');
    expect(html).not.toMatch(/<li|<ul/);
  });

  it('the picker lists the party the rail counts, not cached World companions', () => {
    const party = partyMembers(
      [
        char('own-1', 'Pebble', { last_chatted: '2026-11-20T00:00:00.000Z' }),
        char('sui', 'Sui', { is_default: true, last_chatted: '2026-11-23T00:00:00.000Z' }),
        char('world-1', 'Aria', { owner: 'someone-else' }),
        char('marv', 'Marv', { is_default: true }),
      ] as never[],
      null,
      new Set(['sui']),
      new Set(),
    );
    const html = renderToStaticMarkup(<FreeSlotPickerView party={party} onPick={noop} onClose={noop} />);
    expect(html).toContain('Pick who to unbind.');
    expect(html).toContain('nothing changes until you confirm');
    // Most recently active first, as on the rail.
    const ids = [...html.matchAll(/data-party-member="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['sui', 'own-1']);
    expect(html).not.toContain('Aria');
    expect(html).not.toContain('Marv');
  });

  it('the import notice, the import modal and the Settings row offer Free a slot', () => {
    const notice = renderToStaticMarkup(
      <Banner kind="info" message="full" action={<FreeSlotButton surface="import_notice" />} onDismiss={noop} />,
    );
    expect(notice).toContain('data-free-slot="import_notice"');

    const modal = renderToStaticMarkup(
      <ImportLocalProfileModalView
        peek={fullPeek}
        existingAccount
        status="full"
        onDecline={noop}
        onImport={noop}
        onContinue={noop}
      />,
    );
    expect(modal).toContain('data-free-slot="import_modal"');

    const row = renderToStaticMarkup(<LocalImportRowView peek={fullPeek} onOpen={noop} />);
    expect(row).toContain('data-free-slot="import_settings"');
    const roomy = renderToStaticMarkup(
      <LocalImportRowView peek={{ ...fullPeek, party: { count: 1, incoming: 2, limit: 4, fits: true } }} onOpen={noop} />,
    );
    expect(roomy).not.toContain('data-free-slot');
  });

  it('the copy is in all six dictionaries', () => {
    const keys = [
      PARTY_FULL_HINT,
      FREE_A_SLOT,
      'Pick who to unbind. Their page opens at Unbind, and nothing changes until you confirm.',
    ];
    expect(Object.keys(DICTIONARIES)).toHaveLength(6);
    for (const [lang, dict] of Object.entries(DICTIONARIES)) {
      for (const key of keys) expect(dict[key], `${lang}: ${key}`).toBeTruthy();
    }
  });
});
