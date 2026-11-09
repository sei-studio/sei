/**
 * ProfileSettings (product call 261110), server-rendered: your own companion
 * is one page of sections in use order, someone else's shows only the rows
 * that are yours for it (no locked owner rows), and no row carries a
 * subtext line. Effects (IPC reads) do not run under renderToStaticMarkup,
 * so values that come from IPC (and rows that wait on one) are not checked.
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
const { profileAccess } = await import('../../lib/profileRows');
type Kind = Parameters<typeof profileAccess>[0]['kind'];

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

function render(kind: Kind, extra: Partial<Parameters<typeof profileAccess>[0]> = {}, metadata?: object): string {
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
      character: metadata ? ({ ...character, metadata } as typeof character) : character,
      access,
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
      refreshKey: 0,
    }),
  );
}

const rows = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
const sectionsOf = (html: string): string[] => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
const locked = (html: string): string[] =>
  [...html.matchAll(/data-row="([^"]+)" data-locked="true"/g)].map((m) => m[1]);

describe('ProfileSettings, your own companion', () => {
  it('one page: every section in use order, with headings', () => {
    const html = render('custom', { seilinkOn: true });
    expect(sectionsOf(html)).toEqual(['look', 'voice', 'personality', 'games', 'sharing', 'worldlink', 'danger']);
    for (const h of ['>Look<', '>Voice<', '>Personality<', '>Games<', '>Sharing<', '>WorldLink<', '>Danger zone<']) {
      expect(html).toContain(h);
    }
    expect(rows(html)).toEqual([
      'card-image',
      'skin',
      'avatar',
      'floating-avatar',
      'voice',
      'pitch',
      'about',
      'persona',
      'knowledge',
      'chess',
      'dst',
      'public',
      'desktop-room',
      'room',
      'intro',
      'reset-memory',
      'unbind',
    ]);
  });

  it('nothing is locked, the edit actions are there, duplicates are gone', () => {
    const html = render('custom');
    expect(locked(html)).toEqual([]);
    expect(html).toContain('>Name and description<');
    expect(html).not.toContain('>Rename<');
    expect(html).not.toContain('>In-game username<');
    // The username sits in the skin row's value.
    expect(html).toContain('>Sui<');
  });

  it('awakened: the cast surfaces are locked with the reason', () => {
    const html = render('awakened');
    expect(locked(html)).toEqual(['voice', 'about', 'persona', 'chess']);
    expect(html).toContain('Locked: Sui was awakened by Sei');
  });

  it('an uploaded card image has no Regenerate (product call 261110)', () => {
    const upload = { voiceId: 'v-sarah', portrait_versions: [{ file: 'c1.png', created_at: '', source: 'upload' }], portrait_active: 'c1.png' };
    const withImage = { ...character, portrait_image: 'c1.png' };
    const html = renderToStaticMarkup(
      React.createElement(ProfileSettings, {
        character: { ...withImage, metadata: upload } as typeof character,
        access: profileAccess({ kind: 'custom', inLibrary: true, seilinkOn: false, movedInHere: false, ownVoice: false, noVoice: false }),
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
        refreshKey: 0,
      }),
    );
    expect(html).toContain('>Custom image<');
    expect(html).not.toContain('Regenerate');
    const regen = { voiceId: 'v-sarah', portrait_versions: [{ file: 'c1-v2.png', created_at: '', source: 'regen' }], portrait_active: 'c1-v2.png' };
    const html2 = renderToStaticMarkup(
      React.createElement(ProfileSettings, {
        character: { ...withImage, portrait_image: 'c1-v2.png', metadata: regen } as typeof character,
        access: profileAccess({ kind: 'custom', inLibrary: true, seilinkOn: false, movedInHere: false, ownVoice: false, noVoice: false }),
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
        refreshKey: 0,
      }),
    );
    expect(html2).toContain('Regenerate');
  });

  it('No voice: no sample button and no Pitch row', () => {
    const html = render('custom', { noVoice: true }, { voiceId: 'none' });
    expect(rows(html)).not.toContain('pitch');
    expect(html).not.toContain('Play voice sample');
    expect(render('custom')).toContain('Play voice sample');
  });
});

describe("ProfileSettings, someone else's companion (Your settings)", () => {
  for (const kind of ['builtin', 'world'] as const) {
    it(`${kind}: only your rows, nothing locked, no owner controls`, () => {
      const html = render(kind, { seilinkOn: true });
      expect(locked(html)).toEqual([]);
      // Avatar waits on its library read (and only shows with two or more).
      expect(rows(html)).toEqual(['floating-avatar', 'knowledge', 'dst', 'desktop-room', 'room', 'intro', 'reset-memory', 'unbind']);
      for (const owner of ['card-image', 'skin', 'voice', 'persona', 'about', 'chess', 'public']) {
        expect(rows(html)).not.toContain(owner);
      }
      expect(html).not.toContain('Regenerate');
      expect(html).not.toContain('>Report<');
    });
  }

  it('a preview renders nothing (no settings until it is yours)', () => {
    expect(rows(render('world', { inLibrary: false }))).toEqual([]);
  });
});

describe('copy rules', () => {
  it('no row has a subtext line: explanations are tooltips, not text', () => {
    for (const kind of ['custom', 'builtin', 'world', 'awakened'] as const) {
      // Visible text only (the Locked marker's aria-label carries its reason).
      const html = render(kind, { seilinkOn: true, movedInHere: true, ownVoice: true }).replace(/="[^"]*"/g, '');
      expect(html, kind).not.toContain('Companions you create can change all of it.');
      expect(html).not.toContain('Wipes chats and memories');
      expect(html).not.toContain('—');
    }
  });
});
