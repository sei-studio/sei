/**
 * ProfileSettings (product call 261110), server-rendered: your own companion
 * shows one section menu tab at a time (Look ends with Sharing under its own
 * heading, Danger holds Reset memory and Unbind), someone else's shows only the rows
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
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
};

const { ProfileSettings } = await import('./ProfileSettings');
const { profileAccess, profileTabs } = await import('../../lib/profileRows');
type Tab = Parameters<typeof ProfileSettings>[0]['tab'];
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
  skin: {
    source: 'none',
    mojang_username: null,
    png_sha256: null,
    applied_at: null,
  },
  username: null,
  owner: null,
} as unknown as Parameters<typeof ProfileSettings>[0]['character'];

const noop = (): void => undefined;

/** One tab, or (no `tab`) every settings tab of the page in order, concatenated. */
function render(
  kind: Kind,
  extra: Partial<Parameters<typeof profileAccess>[0]> = {},
  metadata?: object,
  tab?: Tab,
  base: typeof character = character,
): string {
  const access = profileAccess({
    kind,
    inLibrary: true,
    seilinkOn: false,
    movedInHere: false,
    ownVoice: false,
    ...extra,
  });
  const tabs = tab ? [tab] : profileTabs(access).filter((t) => t !== 'overview');
  return tabs
    .map((one) =>
      renderToStaticMarkup(
        React.createElement(ProfileSettings, {
          character: metadata ? ({ ...base, metadata } as typeof character) : base,
          access,
          tab: one,
          onAction: noop,
          onTipOpen: noop,
          openTab: noop,
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
      ),
    )
    .join('');
}

const rows = (html: string): string[] => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
const sectionsOf = (html: string): string[] => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
const locked = (html: string): string[] =>
  [...html.matchAll(/data-row="([^"]+)" data-locked="true"/g)].map((m) => m[1]);

describe('ProfileSettings, your own companion', () => {
  it('one tab at a time: a tab heads only a group from elsewhere (Sharing under Look), Danger is just the danger rows', () => {
    const look = render('custom', { seilinkOn: true }, undefined, 'look');
    // Product call 261124: Sharing sits at the bottom of Look, under its own heading.
    expect(rows(look)).toEqual(['card-image', 'avatar', 'floating-avatar', 'public']);
    expect(sectionsOf(look)).toEqual(['sharing']);
    expect(look).toContain('>Sharing<');
    // The Minecraft skin is a game setting, so it leads Games (product call 261116).
    expect(rows(render('custom', { seilinkOn: true }, undefined, 'games'))).toEqual(['skin', 'chess', 'dst']);
    const danger = render('custom', { seilinkOn: true }, undefined, 'danger');
    expect(sectionsOf(danger)).toEqual([]);
    expect(danger).not.toContain('>Danger zone<');
    expect(danger).not.toContain('>Sharing<');
    expect(rows(danger)).toEqual(['reset-memory', 'unbind']);
    const worldlink = render('custom', { seilinkOn: true }, undefined, 'worldlink');
    expect(rows(worldlink)).toEqual(['desktop-room', 'room', 'intro']);
  });

  it("the description is the creator's words, boxed as user text; the placeholder is not", () => {
    // Read-only where it cannot be edited (yours is a text field, 261119).
    const html = render('awakened', {}, undefined, 'personality');
    expect(html).toMatch(/data-user-text="true"[^>]*><p[^>]*>A teasing, sunny gremlin\.<\/p>/);
    const none = render('awakened', {}, undefined, 'personality', { ...character, description: '' } as typeof character);
    expect(none).not.toContain('data-user-text');
    expect(none).toContain('No description yet.');
  });

  it('every row once, in tab order', () => {
    const html = render('custom', { seilinkOn: true });
    expect(rows(html)).toEqual([
      'card-image',
      'avatar',
      'floating-avatar',
      'public',
      'voice',
      'about',
      'persona',
      'knowledge',
      'skin',
      'chess',
      'dst',
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
    const upload = {
      voiceId: 'v-sarah',
      portrait_versions: [{ file: 'c1.png', created_at: '', source: 'upload' }],
      portrait_active: 'c1.png',
    };
    const withImage = { ...character, portrait_image: 'c1.png' };
    const html = renderToStaticMarkup(
      React.createElement(ProfileSettings, {
        character: { ...withImage, metadata: upload } as typeof character,
        tab: 'look',
        access: profileAccess({
          kind: 'custom',
          inLibrary: true,
          seilinkOn: false,
          movedInHere: false,
          ownVoice: false,
        }),
        onAction: noop,
        onTipOpen: noop,
        openTab: noop,
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
    const regen = {
      voiceId: 'v-sarah',
      portrait_versions: [{ file: 'c1-v2.png', created_at: '', source: 'regen' }],
      portrait_active: 'c1-v2.png',
    };
    const html2 = renderToStaticMarkup(
      React.createElement(ProfileSettings, {
        character: {
          ...withImage,
          portrait_image: 'c1-v2.png',
          metadata: regen,
        } as typeof character,
        tab: 'look',
        access: profileAccess({
          kind: 'custom',
          inLibrary: true,
          seilinkOn: false,
          movedInHere: false,
          ownVoice: false,
        }),
        onAction: noop,
        onTipOpen: noop,
        openTab: noop,
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

  it('voice, name and description, persona and chess are edited in the tab, no popup opener (261119)', () => {
    const editors = (html: string): string[] =>
      [...html.matchAll(/data-row="([^"]+)" data-editor="true"/g)].map((m) => m[1]);
    expect(editors(render('custom'))).toEqual(['voice', 'about', 'persona', 'chess']);
    // Nothing to save until something changes: no save bar on open.
    expect(render('custom')).not.toContain('data-save-bar');
    // The fields are there, with the stored values.
    const personality = render('custom', {}, undefined, 'personality');
    expect(personality).toContain('aria-label="Companion name"');
    expect(personality).toContain('A teasing gremlin.');
    expect(render('custom', {}, undefined, 'voice')).toContain('Tune the voice');
    // The old rows' Edit / Change openers are gone from those tabs.
    for (const tab of ['voice', 'personality'] as const) {
      expect(render('custom', {}, undefined, tab)).not.toMatch(/>(Edit|Change)</);
    }
    // An Awakened companion keeps read-only rows: no editor.
    expect(editors(render('awakened'))).toEqual([]);
  });

  it('the publish step sends you to the name and description editor with its reason', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProfileSettings, {
        character,
        tab: 'personality',
        access: profileAccess({ kind: 'custom', inLibrary: true, seilinkOn: false, movedInHere: false, ownVoice: false }),
        onAction: noop,
        onTipOpen: noop,
        openTab: noop,
        aboutNotice: 'Going public needs a description.',
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
    expect(html).toContain('Going public needs a description.');
  });

  it("an awakened companion's voice row plays its sample, a silent one has none", () => {
    expect(render('awakened', {}, undefined, 'voice')).toContain('Play voice sample');
    expect(render('awakened', {}, { voiceId: 'none' }, 'voice')).not.toContain('Play voice sample');
  });
});

describe("ProfileSettings, someone else's companion (Your settings)", () => {
  for (const kind of ['builtin', 'world'] as const) {
    it(`${kind}: only your rows, nothing locked, no owner controls`, () => {
      const html = render(kind, { seilinkOn: true });
      expect(locked(html)).toEqual([]);
      // Avatar waits on its library read (and only shows with two or more).
      expect(rows(html)).toEqual([
        'floating-avatar',
        'knowledge',
        'dst',
        'desktop-room',
        'room',
        'intro',
        'reset-memory',
        'unbind',
      ]);
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
      const html = render(kind, {
        seilinkOn: true,
        movedInHere: true,
        ownVoice: true,
      }).replace(/="[^"]*"/g, '');
      expect(html, kind).not.toContain('Companions you create can change all of it.');
      expect(html).not.toContain('Wipes chats and memories');
      expect(html).not.toContain('—');
    }
  });
});
