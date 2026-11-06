/**
 * ProfileSettings (261107, profile v0.7), server-rendered: each tab renders
 * only its own rows, a locked row shows its value with a Locked marker and no
 * action, and no row carries a subtext line. Effects (IPC reads) do not run
 * under renderToStaticMarkup, so values that come from IPC are not checked.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { window: unknown }).window = {
  sei: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
};

const { ProfileSettings } = await import('./ProfileSettings');
const { PROFILE_TABS, profileAccess } = await import('../../lib/profileRows');
type Kind = Parameters<typeof profileAccess>[0]['kind'];
type Tab = (typeof PROFILE_TABS)[number];

const character = {
  id: 'c1',
  kind: 'custom',
  public_id: null,
  name: 'Sui',
  persona: { source: 'A teasing gremlin.', expanded: '' },
  is_default: false,
  description: 'A teasing, sunny gremlin.',
  shared: true,
  slug: null,
  metadata: { voiceId: 'v-sarah', voicePitch: 1.1 },
  created: '2026-09-28T00:00:00Z',
  last_launched: null,
  playtime_ms: 0,
  skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
  username: null,
  owner: null,
} as unknown as Parameters<typeof ProfileSettings>[0]['character'];

const noop = (): void => undefined;

function render(tab: Tab, kind: Kind, extra: Partial<Parameters<typeof profileAccess>[0]> = {}): string {
  const access = profileAccess({
    kind,
    inLibrary: true,
    seilinkOn: false,
    movedInHere: false,
    ownVoice: false,
    noVoice: false,
    ...extra,
  });
  return renderToStaticMarkup(
    React.createElement(ProfileSettings, {
      character,
      access,
      tab,
      onAction: noop,
      onTipOpen: noop,
      openEdit: noop,
      openCardImage: noop,
      openKnowledge: noop,
      openSkinEdit: noop,
      openAvatars: noop,
      openFloating: noop,
      onToggleShared: noop,
      shareToggleDisabled: false,
      onResetMemory: noop,
      onUnbind: noop,
      onReport: noop,
      refreshKey: 0,
    }),
  );
}

const rows = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
const locked = (html: string): string[] =>
  [...html.matchAll(/data-row="([^"]+)" data-locked="true"/g)].map((m) => m[1]);

describe('ProfileSettings tabs', () => {
  it('each tab renders only its own rows (own companion)', () => {
    expect(rows(render('look', 'custom'))).toEqual(['card-image', 'skin', 'avatar', 'floating-avatar']);
    expect(rows(render('voice', 'custom'))).toEqual(['voice', 'pitch']);
    expect(rows(render('personality', 'custom'))).toEqual(['name', 'description', 'persona', 'knowledge']);
    expect(rows(render('games', 'custom'))).toEqual(['username', 'chess', 'dst']);
    expect(rows(render('sharing', 'custom'))).toEqual(['public']);
    expect(rows(render('danger', 'custom'))).toEqual(['reset-memory', 'unbind']);
  });

  it('own companion: nothing is locked, the edit actions are there', () => {
    for (const tab of PROFILE_TABS) expect(locked(render(tab, 'custom')), tab).toEqual([]);
    const look = render('look', 'custom');
    expect(look).toContain('>Versions<');
    expect(look).toContain('>Manage<');
    expect(render('personality', 'custom')).toContain('>Rename<');
  });

  it('built-in: the made-as-is rows are locked, with the reason as the marker label', () => {
    const look = render('look', 'builtin');
    expect(locked(look)).toEqual(['card-image', 'skin']);
    expect(look).toContain('Locked: Sui is a built-in companion');
    expect(look).not.toContain('>Versions<');
    expect(locked(render('voice', 'builtin'))).toEqual(['voice']);
    expect(rows(render('voice', 'builtin'))).toEqual(['voice']);
    expect(locked(render('personality', 'builtin'))).toEqual(['name', 'description', 'persona']);
    expect(locked(render('games', 'builtin'))).toEqual(['username', 'chess']);
  });

  it('World: Report sits in the Danger zone', () => {
    expect(rows(render('danger', 'world'))).toEqual(['report', 'reset-memory', 'unbind']);
    expect(render('look', 'world')).toContain('Locked: Sui was made by another player');
  });

  it('WorldLink rows appear on the Sharing tab when WorldLink is on', () => {
    expect(rows(render('sharing', 'builtin', { seilinkOn: true }))).toEqual(['desktop-room', 'room', 'intro']);
    expect(rows(render('sharing', 'custom', { seilinkOn: true, movedInHere: true, ownVoice: true }))).toEqual([
      'public',
      'others-hear',
      'desktop-room',
      'room',
      'idle-lines',
      'intro',
    ]);
  });

  it('no row has a subtext line: explanations are tooltips, not text', () => {
    for (const kind of ['custom', 'builtin', 'world', 'awakened'] as const) {
      for (const tab of PROFILE_TABS) {
        // Visible text only (the Locked marker's aria-label carries its reason).
        const html = render(tab, kind, { seilinkOn: true, movedInHere: true, ownVoice: true }).replace(/="[^"]*"/g, '');
        // Tooltip text is only rendered while open (a portal), never inline.
        expect(html, `${kind}/${tab}`).not.toContain('Companions you create can change all of it.');
        expect(html).not.toContain('Wipes chats and memories');
        expect(html).not.toContain('—');
      }
    }
  });
});
